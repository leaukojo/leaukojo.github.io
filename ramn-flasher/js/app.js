// ── Global mode state ────────────────────────────────────────────────
let currentMode = null;
const caps = { usb: !!navigator.usb, serial: !!navigator.serial };

// ── Mode routing ─────────────────────────────────────────────────────
function switchMode(mode) {
  // Wizard modes require both APIs. Redirect to expert if one is missing.
  if ((mode === 'update' || mode === 'newboard') && (!caps.usb || !caps.serial)) {
    mode = 'expert';
  }

  currentMode = mode;
  localStorage.setItem('ramn-mode', mode);
  history.replaceState(null, '', '#' + mode);

  $('modeSelector').style.display   = 'none';
  $('expertLayout').style.display   = mode === 'expert' ? '' : 'none';
  $('wizardLayout').style.display   = (mode === 'update' || mode === 'newboard') ? '' : 'none';

  if (mode === 'expert') {
    if (!caps.usb && caps.serial) {
      // Only serial: lock to ECU B/C/D, hide target picker (no choice to make)
      $('ecuTargetCard').style.display = 'none';
      setEcuTarget('BCD');
    } else if (caps.usb && !caps.serial) {
      // Only USB: lock to ECU A, hide target picker
      $('ecuTargetCard').style.display = 'none';
      setEcuTarget('A');
    } else {
      $('ecuTargetCard').style.display = '';
      setEcuTarget('both');
    }
    restoreCollapsibleState();
  }
  if (mode === 'update') {
    $('wizModeLabel').textContent = 'Update RAMN';
    showWizSetup('update');
  }
  if (mode === 'newboard') {
    $('wizModeLabel').textContent = 'First-Time Setup / Recovery';
    showWizSetup('newboard');
  }
}

function showModeSelector() {
  currentMode = null;
  $('modeSelector').style.display   = '';
  $('expertLayout').style.display   = 'none';
  $('wizardLayout').style.display   = 'none';
}

// ── Wizard phase helpers ─────────────────────────────────────────────
function showWizSetup(mode) {
  $('wizSetupUpdate').style.display   = mode === 'update'   ? '' : 'none';
  $('wizSetupNewboard').style.display = mode === 'newboard' ? '' : 'none';
  $('wizFlashPhase').style.display    = 'none';
  // Always reset to the GitHub default and sync all conditional UI, so
  // the form is consistent regardless of what was selected previously.
  if (mode === 'update') {
    const radio = document.querySelector('input[name="wizFwSource"][value="gh"]');
    if (radio) { radio.checked = true; onWizSourceChange(radio); }
  }
  if (mode === 'newboard') {
    const radio = document.querySelector('input[name="wizNbFwSource"][value="gh"]');
    if (radio) { radio.checked = true; onWizNbSourceChange(radio); }
  }
}

function showWizFlash() {
  $('wizSetupUpdate').style.display   = 'none';
  $('wizSetupNewboard').style.display = 'none';
  $('wizFlashPhase').style.display    = '';
  $('wizStepList').innerHTML          = '';
  $('wizProgressWrap').style.display  = 'none';
  $('wizDoneActions').style.display   = 'none';
  $('wizLogArea').style.display       = 'none';
  $('btnWizLog').textContent          = 'Show log';
  $('btnWizStartOver').disabled       = true;
}

// ── Wizard log toggle ────────────────────────────────────────────────
function toggleWizLog() {
  const area = $('wizLogArea');
  const btn  = $('btnWizLog');
  const hidden = area.style.display === 'none';
  area.style.display = hidden ? '' : 'none';
  btn.textContent = hidden ? 'Hide log' : 'Show log';
}

// ── Wizard start over ────────────────────────────────────────────────
function wizStartOver() {
  if (serConnected)  doDisconnectSerial();
  if (usbDev)        doDisconnect();
  clearAllFw();
  showWizSetup(currentMode);
}

// ── Wizard source radios ─────────────────────────────────────────────
function onWizSourceChange(radio) {
  const src = radio.value;
  const ghAdv  = $('wizGhAdvanced');
  const filePk = $('wizFilePicker');
  if (ghAdv)  ghAdv.style.display  = src === 'gh'   ? '' : 'none';
  if (filePk) filePk.style.display = src === 'file' ? '' : 'none';
  if (src === 'gh') syncWizVariant();
  if (src === 'file') {
    clearAllFw();
  } else {
    // Switching away from file: re-enable the log checkbox so the user
    // can choose freely (the remote fetch will provide both variants).
    const el = $('wizChkLog');
    if (el) el.disabled = false;
  }
  ['gh','rel','file'].forEach(v => {
    const el = $('wiz-opt-' + v);
    if (el) el.classList.toggle('wiz-radio-selected', v === src);
  });
  updateWizFlashButtons();
}

function onWizNbSourceChange(radio) {
  const src = radio.value;
  const filePk = $('wizNbFilePicker');
  if (filePk) filePk.style.display = src === 'file' ? '' : 'none';
  if (src === 'file') {
    clearAllFw();
  } else {
    const el = $('wizNbChkLog');
    if (el) el.disabled = false;
  }
  ['gh','rel','file'].forEach(v => {
    const el = $('wizNb-opt-' + v);
    if (el) el.classList.toggle('wiz-radio-selected', v === src);
  });
  updateWizFlashButtons();
}

// ── Validate wizard firmware completeness ────────────────────────────
function updateWizFlashButtons() {
  const mode = currentMode;
  if (mode !== 'update' && mode !== 'newboard') return;

  const isUpdate   = mode === 'update';
  const srcName    = isUpdate ? 'wizFwSource' : 'wizNbFwSource';
  const srcRadio   = document.querySelector(`input[name="${srcName}"]:checked`);
  const src        = srcRadio ? srcRadio.value : 'gh';
  const btnId      = isUpdate ? 'btnWizFlashUpdate'  : 'btnWizFlashNewboard';
  const errId      = isUpdate ? 'wizUpdateErr'        : 'wizNewboardErr';
  const btn = $(btnId), errEl = $(errId);
  if (!btn) return;

  if (src !== 'file') {
    // Remote fetch will get everything — always enabled
    btn.disabled = false;
    if (errEl) errEl.style.display = 'none';
    return;
  }

  // File source: check all four ECUs are covered
  const missing = [];
  if (!fwBuf)                    missing.push('ECU A');
  if (!fwBufB && !fwBufBLinear)  missing.push('ECU B');
  if (!fwBufC)                   missing.push('ECU C');
  if (!fwBufD)                   missing.push('ECU D');

  if (missing.length === 4) {
    // Nothing loaded yet — neutral state, button disabled, no error shown
    btn.disabled = true;
    if (errEl) errEl.style.display = 'none';
    return;
  }

  if (missing.length > 0) {
    btn.disabled = true;
    if (errEl) {
      errEl.style.display = '';
      errEl.innerHTML = `Missing firmware for <b>${missing.join(', ')}</b>. `
        + 'To flash individual ECUs, use '
        + '<button class="btn-link" onclick="switchMode(\'expert\')">Expert Mode</button>.';
    }
  } else {
    btn.disabled = false;
    if (errEl) errEl.style.display = 'none';
  }
}

function toggleWizAdvanced() {
  const body = $('wizGhAdvBody');
  const btn  = $('wizGhAdvBtn');
  const open = body.style.display === 'none';
  body.style.display = open ? '' : 'none';
  btn.textContent = open ? 'Advanced ▴' : 'Advanced ▾';
  if (open) syncWizVariant();
}

function syncWizVariant() {
  // Populate wizard variant select from the shared #fwDirSelect, preserving optgroups
  const src = $('fwDirSelect'), dst = $('wizVariantSelect');
  if (!src || !dst || src.options.length === 0) return;
  const cur = dst.value;
  dst.innerHTML = '';
  for (const child of src.children) {
    if (child.tagName === 'OPTGROUP') {
      const grp = document.createElement('optgroup');
      grp.label = child.label;
      for (const opt of child.children) {
        const o = document.createElement('option');
        o.value = opt.value; o.textContent = opt.textContent;
        grp.appendChild(o);
      }
      dst.appendChild(grp);
    } else {
      const o = document.createElement('option');
      o.value = child.value; o.textContent = child.textContent;
      dst.appendChild(o);
    }
  }
  dst.value = cur;
}

function onWizVariantChange() {
  // Mirror selected variant to the shared #fwDirSelect used by fetchFw()
  const dst = $('wizVariantSelect'), src = $('fwDirSelect');
  if (src && dst) src.value = dst.value;
  // Hide logarithmic option for CTF firmware (no linear/log variant exists)
  const isCTF = dst ? dst.value.startsWith('ctf:') : false;
  const wizItem = $('wizChkLogItem');
  if (wizItem) wizItem.style.display = isCTF ? 'none' : '';
}

// ── Collect wizard setup options ─────────────────────────────────────
function readWizOpts(mode) {
  if (mode === 'update') {
    const src = document.querySelector('input[name="wizFwSource"]:checked');
    return {
      fwSource:    src ? src.value : 'gh',
      logarithmic: $('wizChkLog').checked,
      skipVerify:  $('wizChkSkipVerify').checked,
      variant:     ($('wizVariantSelect') && $('wizVariantSelect').value) || '',
    };
  } else {
    const src = document.querySelector('input[name="wizNbFwSource"]:checked');
    return {
      fwSource:    src ? src.value : 'gh',
      logarithmic: $('wizNbChkLog').checked,
      skipVerify:  $('wizNbChkSkipVerify').checked,
      variant:     '',
    };
  }
}

// ── CTF log-option visibility ────────────────────────────────────────
function updateCtfLogUI() {
  const isCTF = ctfVariant !== null;
  const wizItem = $('wizChkLogItem');
  if (wizItem) wizItem.style.display = isCTF ? 'none' : '';
  const expWrap = $('chkBLogWrap');
  if (expWrap) expWrap.style.display = isCTF ? 'none' : '';
}

// ── CTF confirmation modal ───────────────────────────────────────────
function showCTFModal(ctfName, onConfirm) {
  $('ctfModalName').textContent = ctfName.replace(/_/g, ' ');
  $('ctfModal').style.display = '';
  $('ctfModalCancel').onclick  = () => { $('ctfModal').style.display = 'none'; };
  $('ctfModalConfirm').onclick = () => { $('ctfModal').style.display = 'none'; onConfirm(); };
}

// ── Start flash from wizard ──────────────────────────────────────────
function startWizardFlash(mode) {
  const opts = readWizOpts(mode);
  const variantVal = $('wizVariantSelect') ? $('wizVariantSelect').value : '';
  if (variantVal.startsWith('ctf:')) {
    showCTFModal(variantVal.slice(4), () => {
      showWizFlash();
      if (mode === 'update') runUpdateFlash(opts);
      else                   runNewBoardFlash(opts);
    });
  } else {
    showWizFlash();
    if (mode === 'update') runUpdateFlash(opts);
    else                   runNewBoardFlash(opts);
  }
}

// ── Collapsible sections (expert mode) ───────────────────────────────
function toggleSection(cardId) {
  const card = $(cardId);
  if (!card) return;
  const collapsed = card.classList.toggle('collapsed');
  localStorage.setItem('ramn-collapsed-' + cardId, collapsed ? '1' : '0');
}

function restoreCollapsibleState() {
  ['fwFullCard','ecuTargetCard','howToCard','secACard','secBCDCard'].forEach(id => {
    const card = $(id);
    if (!card) return;
    const stored = localStorage.getItem('ramn-collapsed-' + id);
    if (stored === '1') card.classList.add('collapsed');
    else                card.classList.remove('collapsed');
  });
}

// ── Help modal ────────────────────────────────────────────────────────
function openModal(tabId) {
  $('helpModal').style.display = '';
  switchTab(tabId);
}

function closeModal() {
  $('helpModal').style.display = 'none';
}

function switchTab(tabId) {
  [
    { id:'ecuBType', btn:'tabEcuBType', content:'contentEcuBType' },
    { id:'browser',  btn:'tabBrowser',  content:'contentBrowser'  },
  ].forEach(({ id, btn, content }) => {
    const b = $(btn), c = $(content);
    if (b) b.classList.toggle('active', id === tabId);
    if (c) c.style.display = id === tabId ? '' : 'none';
  });
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Init ─────────────────────────────────────────────────────────────
(function init() {
  // Apply mode selector state based on API availability
  if (!caps.usb || !caps.serial) {
    const w = $('msWarning');
    w.style.display = '';
    if (!caps.usb && !caps.serial) {
      w.textContent = 'WebUSB and Web Serial are not available. Chrome or Edge 89+ is required.';
    } else if (!caps.usb) {
      w.textContent = 'WebUSB is not available — ECU A (DFU) cannot be flashed. Wizard modes are disabled; use Expert Mode for ECU B/C/D.';
    } else {
      w.textContent = 'Web Serial is not available — ECU B/C/D cannot be flashed. Wizard modes are disabled; use Expert Mode for ECU A.';
    }

    // Disable wizard mode cards on the selector — they require both APIs
    const unavailDesc = !caps.usb
      ? 'Requires WebUSB, which is not available in this browser.'
      : 'Requires Web Serial, which is not available in this browser.';
    ['btnMsUpdate', 'btnMsNewboard'].forEach(id => {
      const card = $(id);
      if (!card) return;
      card.classList.add('ms-card-unavailable');
      const desc = card.querySelector('.ms-card-desc');
      if (desc) desc.textContent = unavailDesc;
    });
  }

  const params = new URLSearchParams(location.search);
  const ctfParam = params.get('ctf');
  if (ctfParam && /^[\w-]+$/.test(ctfParam)) {
    pendingCtfVariant = ctfParam;
  }

  const hash   = location.hash.replace('#', '');
  const stored = localStorage.getItem('ramn-mode');
  // ?ctf= forces Update mode (the only wizard that supports CTF auto-flash)
  const mode   = pendingCtfVariant ? 'update'
    : (['expert','update','newboard'].includes(hash) ? hash : stored);

  if (mode === 'expert' || mode === 'update' || mode === 'newboard') {
    switchMode(mode);
  } else {
    showModeSelector();
  }
})();
