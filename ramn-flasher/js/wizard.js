// ── Wizard step helpers ───────────────────────────────────────────────
// States: 'pending' | 'active' | 'done' | 'error'
function setWizardStep(id, state, label, detail) {
  let el = $('wizStep-' + id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'wizStep-' + id;
    el.className = 'wiz-step';
    $('wizStepList').appendChild(el);
  }
  const dotChar = state === 'done' ? '✓' : state === 'error' ? '✕' : '';
  el.innerHTML = `
    <div class="wiz-step-dot ${state}">${dotChar}</div>
    <div class="wiz-step-body">
      <div class="wiz-step-label${state === 'pending' ? ' pending' : ''}">${label}</div>
      ${detail ? `<div class="wiz-step-detail">${detail}</div>` : ''}
    </div>`;
}

function wizEnableStartOver() {
  $('btnWizStartOver').disabled = false;
}

// ── Configure shared firmware DOM before calling firmware functions ───
function applyWizFwOpts(opts) {
  // Mirror logarithmic choice to the expert-mode checkbox (used by CAN flash logic)
  $('chkBLog').checked = opts.logarithmic;
  // Mirror variant to shared #fwDirSelect (used by fetchFw())
  if (opts.fwSource === 'gh') {
    $('fwDirSelect').value = opts.variant || '';
    // Trigger the onchange side-effect (updates path hint text)
    onDirChange();
  }
}

// ── CTF recovery hint ─────────────────────────────────────────────────
function showWizardCtfHint() {
  if ($('wizCtfHint')) return; // only show once
  const portal = CTF_PORTAL_URL !== 'TODO'
    ? `<a href="${CTF_PORTAL_URL}" target="_blank" rel="noopener">RAMN CTF Portal →</a>`
    : `<span>RAMN CTF Portal (coming soon)</span>`;
  const reset = CTF_RESET_TOOL_URL !== 'TODO'
    ? `<a href="${CTF_RESET_TOOL_URL}" target="_blank" rel="noopener">Post-CTF board reset tool →</a>`
    : `<span>Post-CTF board reset tool (coming soon)</span>`;
  const el = document.createElement('div');
  el.id = 'wizCtfHint';
  el.className = 'wiz-ctf-hint';
  el.innerHTML = `<strong>If you flashed CTF firmware</strong>, your board can be restored `
    + `using the post-CTF reset tool. ${reset} &nbsp;·&nbsp; ${portal}`;
  $('wizStepList').appendChild(el);
}

// ── runUpdateFlash — Update RAMN flash sequence ──────────────────────
// fetch → connect serial → flash B/C/D → trigger DFU → connect DFU (button) → flash A
async function runUpdateFlash(opts) {
  opts = opts || {};
  $('wizFlashTitle').textContent = 'Updating RAMN…';
  let serialReached = false;

  // Step 1: Firmware
  if (opts.skipFetch && fwBuf) {
    setWizardStep('fw', 'done', 'Firmware loaded', 'Using currently loaded firmware');
  } else {
    setWizardStep('fw', 'active', 'Downloading firmware', '');
    applyWizFwOpts(opts);
    if (opts.fwSource === 'gh')   await fetchFw();
    else if (opts.fwSource === 'rel') await fetchRelease();
    // 'file' case: firmware already loaded via canDirInput handler
    if (!fwBuf) {
      setWizardStep('fw', 'error', 'Downloading firmware', 'Failed — check your connection and try again.');
      wizEnableStartOver(); return;
    }
    setWizardStep('fw', 'done', 'Firmware downloaded', '');
  }

  // Step 2: Connect serial (user gesture carries from "Flash All ECUs" click through fetchFw network I/O)
  setWizardStep('serial', 'active', 'Connecting to ECU A (serial)', 'Select your RAMN in the browser dialog…');
  await doConnectSerial();
  if (!serConnected) {
    setWizardStep('serial', 'error', 'Connecting to ECU A (serial)', 'No port selected. Make sure RAMN is plugged in.');
    // Suggest recovery mode in case ECU A is stuck in DFU from a previous failed flash
    const step = $('wizStep-serial');
    if (step) {
      const hint = document.createElement('div');
      hint.className = 'wiz-recovery-hint';
      hint.innerHTML = 'If ECU A is stuck in DFU mode from a previous failed flash, '
        + '<button class="btn-link" onclick="switchMode(\'newboard\')">switch to Recovery Mode →</button>';
      step.querySelector('.wiz-step-body').appendChild(hint);
    }
    wizEnableStartOver(); return;
  }
  setWizardStep('serial', 'done', 'Connected to ECU A (serial)', '');
  serialReached = true;

  // Step 3: Flash ECU B/C/D
  ['chkB','chkC','chkD'].forEach(id => $(id).checked = true);
  updateCanFlashBtn();
  const prevReset = $('chkReset').checked;
  $('chkReset').checked = false;
  setWizardStep('flashBCD', 'active', 'Flashing ECU B/C/D', '');
  setFwCardBusy(true);
  if (opts.skipVerify) await doFlashAllCAN();
  else                 await doFlashAndVerifyAllCAN();
  setFwCardBusy(false);
  $('chkReset').checked = prevReset;
  setWizardStep('flashBCD', 'done', 'ECU B/C/D flashed', '');

  // Step 4: Trigger DFU on ECU A, disconnect serial
  setWizardStep('triggerDFU', 'active', 'Restarting ECU A into DFU mode', '');
  try { await serialWrite('DzZ\r'); await sleep(300); } catch(e) {}
  await doDisconnectSerial();
  setWizardStep('triggerDFU', 'done', 'ECU A restarting…', '');

  // Step 5: Connect DFU — user gesture has expired after CAN flash; need second click
  setWizardStep('dfu', 'active', 'Connecting ECU A (DFU)', '');
  await new Promise(resolve => {
    // Inject a pulsing button into the step detail
    const step = $('wizStep-dfu');
    const body = step ? step.querySelector('.wiz-step-body') : null;
    if (body) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary qf-pulse';
      btn.style.cssText = 'margin-top:.5rem;width:100%;justify-content:center';
      btn.textContent = '▶ Click here to connect the DFU device';
      btn.onclick = async () => { btn.remove(); await doConnect(); resolve(); };
      body.appendChild(btn);
    } else { resolve(); }
  });
  if (!usbDev) {
    setWizardStep('dfu', 'error', 'Connecting ECU A (DFU)', 'No device selected. Make sure the USB cable is connected.');
    if (serialReached) showWizardCtfHint();
    wizEnableStartOver(); return;
  }
  setWizardStep('dfu', 'done', 'ECU A (DFU) connected', '');

  // Step 6: Flash ECU A
  setWizardStep('flashA', 'active', 'Flashing ECU A', '');
  setFwCardBusy(true);
  if (opts.skipVerify) await doFlash();
  else                 await doFlashAndVerifyDFU();
  setFwCardBusy(false);
  setWizardStep('flashA', 'done', 'ECU A flashed', '');

  // Done
  $('wizFlashTitle').textContent = 'All ECUs updated!';
  $('wizDoneMsg').textContent = ctfVariant
    ? 'CTF firmware flashed successfully. When you are done with the CTF, restore standard firmware using the reset tool below.'
    : 'Your RAMN board is now running the latest firmware.';
  if (ctfVariant) {
    const portalLink = $('wizCtfPortalLink'), resetLink = $('wizCtfResetLink');
    if (portalLink) portalLink.href = CTF_PORTAL_URL !== 'TODO' ? CTF_PORTAL_URL : '#';
    if (resetLink)  resetLink.href  = CTF_RESET_TOOL_URL !== 'TODO' ? CTF_RESET_TOOL_URL : '#';
    $('wizCtfDoneLinks').style.display = '';
  } else {
    $('wizCtfDoneLinks').style.display = 'none';
  }
  $('wizDoneActions').style.display = '';
  wizEnableStartOver();
  log('Wizard: all ECUs updated ✓', 'log-ok');
}

// ── runNewBoardFlash — First-Time Setup flash sequence ────────────────
// Order: fetch → connect DFU (auto gesture) → flash A → wait → connect serial (button) → flash B/C/D
async function runNewBoardFlash(opts) {
  opts = opts || {};
  $('wizFlashTitle').textContent = 'Setting up your RAMN board…';
  let ecuAFlashed = false;

  // Step 1: Firmware
  setWizardStep('fw', 'active', 'Downloading firmware', '');
  applyWizFwOpts(opts);
  if (opts.fwSource === 'gh')       await fetchFw();
  else if (opts.fwSource === 'rel') await fetchRelease();
  if (!fwBuf) {
    setWizardStep('fw', 'error', 'Downloading firmware', 'Failed — check your connection and try again.');
    wizEnableStartOver(); return;
  }
  setWizardStep('fw', 'done', 'Firmware downloaded', '');

  // Step 2: Connect DFU (user gesture still valid — fetchFw is network-only)
  setWizardStep('dfu', 'active', 'Connecting ECU A (DFU)',
    'Select "DFU in FS mode" or similar in the browser dialog…');
  await doConnect();
  if (!usbDev) {
    setWizardStep('dfu', 'error', 'Connecting ECU A (DFU)',
      'No device selected. Make sure the USB cable is connected and ECU A is in DFU mode.');
    wizEnableStartOver(); return;
  }
  setWizardStep('dfu', 'done', 'ECU A (DFU) connected', '');

  // Step 3: Flash ECU A
  setWizardStep('flashA', 'active', 'Flashing ECU A', '');
  setFwCardBusy(true);
  if (opts.skipVerify) await doFlash();
  else                 await doFlashAndVerifyDFU();
  setFwCardBusy(false);
  setWizardStep('flashA', 'done', 'ECU A flashed', '');
  ecuAFlashed = true;

  // Step 4: Wait for ECU A to reboot into app mode (DFU leave=true triggers auto-reboot)
  setWizardStep('reboot', 'active', 'ECU A restarting…', '');
  await new Promise(resolve => {
    let n = 3;
    const iv = setInterval(() => {
      const step = $('wizStep-reboot');
      const detail = step ? step.querySelector('.wiz-step-detail') : null;
      if (detail) detail.textContent = `ECU A is restarting… ${n}s`;
      if (--n < 0) { clearInterval(iv); resolve(); }
    }, 1000);
  });
  setWizardStep('reboot', 'done', 'ECU A restarted', '');

  // Step 5: Connect serial — user gesture expired; inject Continue button
  setWizardStep('serial', 'active', 'Connecting ECU A (serial)', '');
  await new Promise(resolve => {
    const step = $('wizStep-serial');
    const body = step ? step.querySelector('.wiz-step-body') : null;
    if (body) {
      const det = body.querySelector('.wiz-step-detail');
      if (det) det.textContent = 'Select the port labeled "USB Serial Device" or similar.';
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.style.cssText = 'margin-top:.5rem';
      btn.textContent = 'Continue — select serial port';
      btn.onclick = async () => { btn.remove(); await doConnectSerial(); resolve(); };
      body.appendChild(btn);
    } else { resolve(); }
  });
  if (!serConnected) {
    setWizardStep('serial', 'error', 'Connecting ECU A (serial)',
      'No port selected. Make sure RAMN is plugged in and ECU A is running.');
    if (ecuAFlashed) showWizardCtfHint();
    wizEnableStartOver(); return;
  }
  setWizardStep('serial', 'done', 'Connected to ECU A (serial)', '');

  // Step 6: Flash ECU B/C/D
  ['chkB','chkC','chkD'].forEach(id => $(id).checked = true);
  updateCanFlashBtn();
  const prevReset = $('chkReset').checked;
  $('chkReset').checked = false;
  setWizardStep('flashBCD', 'active', 'Flashing ECU B/C/D', '');
  setFwCardBusy(true);
  if (opts.skipVerify) await doFlashAllCAN();
  else                 await doFlashAndVerifyAllCAN();
  setFwCardBusy(false);
  $('chkReset').checked = prevReset;
  setWizardStep('flashBCD', 'done', 'ECU B/C/D flashed', '');

  // Step 7: Reset RAMN — serial is still open; canResetRAMN sends reset and disconnects
  setWizardStep('reset', 'active', 'Resetting RAMN', '');
  await canResetRAMN();
  setWizardStep('reset', 'done', 'RAMN reset', '');

  // Done
  $('wizFlashTitle').textContent = 'Setup complete!';
  $('wizDoneMsg').textContent = 'All four ECUs have been programmed. Your RAMN board is ready.';
  $('wizDoneActions').style.display = '';
  wizEnableStartOver();
  log('Wizard: First-Time Setup complete ✓', 'log-ok');
}
