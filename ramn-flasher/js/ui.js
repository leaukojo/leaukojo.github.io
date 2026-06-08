// ── Helpers ───────────────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const p2=n=>String(n).padStart(2,'0'), p3=n=>String(n).padStart(3,'0');
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const hex=(n,p=8)=>'0x'+(n>>>0).toString(16).toUpperCase().padStart(p,'0');
const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(1,ms)));
function ts(){const d=new Date();return`${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`}

function log(msg,cls=''){
  const d=document.createElement('div');
  d.className='log-line';
  d.innerHTML=`<span class="log-time">[${ts()}]</span><span class="${cls}">${esc(msg)}</span>`;
  const el=$('logArea');
  if(el){el.appendChild(d);el.scrollTop=el.scrollHeight;}
  const wizEl=$('wizLogAreaInner');
  if(wizEl){wizEl.appendChild(d.cloneNode(true));wizEl.scrollTop=wizEl.scrollHeight;}
}
function clearLog(){$('logArea').innerHTML=''}

function setSt(phase,detail,type=''){
  $('statusPhase').textContent=phase;$('statusDetail').textContent=detail;
  $('statusDot').className='status-dot'+(type?` ${type}`:'');
}
function setProgress(label,pct){
  // In wizard mode, update the wizard's progress bar; otherwise use the expert layout's.
  const inWiz=typeof currentMode!=='undefined'&&(currentMode==='update'||currentMode==='newboard');
  const wrap =inWiz?'wizProgressWrap':'progressWrap';
  const lbl  =inWiz?'wizProgressLabel':'progressLabel';
  const pctId=inWiz?'wizProgressPct':'progressPct';
  const fillId=inWiz?'wizProgressFill':'progressFill';
  $(wrap).style.display='';
  $(lbl).textContent=label;$(pctId).textContent=Math.round(pct)+'%';
  const fill=$(fillId);
  if(pct===0){
    fill.style.transition='none';
    fill.style.width='0%';
    fill.getBoundingClientRect();
    fill.style.transition='';
  }else{
    fill.style.width=pct+'%';
  }
}

function setDevUI(conn,name,sub){
  $('devIndicator').className='device-indicator'+(conn?' connected':'');
  $('devName').textContent=name;$('devSub').textContent=sub;
  $('btnConnect').textContent=conn?'Disconnect':'Connect';
  $('btnTriggerDFU').disabled=!!conn;
  updateFlashBtn();
}
function updateFlashBtn(){
  const ready=!!(usbDev&&fwBuf);
  $('btnFlash').disabled=!ready;
  $('btnFlashVerifyDFU').disabled=!ready;
  updateWizFileStatus();
}

function updateWizFileStatus(){
  const mode=typeof currentMode!=='undefined'?currentMode:null;
  const el=(mode==='newboard')?$('wizNbFileStatus'):$('wizFileStatus');
  if(!el) return;
  const parts=[];
  if(fwBuf) parts.push('ECU A');
  if(fwBufB&&fwBufBLinear) parts.push('ECU B (Log+Lin)');
  else if(fwBufB) parts.push('ECU B (Log)');
  else if(fwBufBLinear) parts.push('ECU B (Lin)');
  if(fwBufC) parts.push('ECU C');
  if(fwBufD) parts.push('ECU D');
  if(parts.length){el.textContent='Loaded: '+parts.join(', ');el.style.color='var(--success)';}
  else{el.textContent='';el.style.color='';}
}
function updateCanFlashBtn(){
  const anyReady=($('chkB').checked&&!!fwBufB)||($('chkC').checked&&!!fwBufC)||($('chkD').checked&&!!fwBufD);
  const enabled=!!(serConnected&&anyReady);
  $('btnFlashCAN').disabled=!enabled;
  $('btnVerifyCAN').disabled=!enabled;
  $('btnFlashVerifyCAN').disabled=!enabled;
}

function updateLinearMsg(){
  const el=$('chkBLog');
  $('chkBLogMsg').style.display=(!el.checked&&!fwBufBLinear&&!el.disabled)?'':'none';
}

function onChkBChange(){
  $('chkBLogWrap').style.display=$('chkB').checked?'flex':'none';
  updateLinearMsg();
  updateCanFlashBtn();
}

function syncFwCheckboxes(){
  // ECU B — expert mode checkbox
  const hasB=!!(fwBufB||fwBufBLinear);
  const chkBEl=$('chkB'),chkBLogEl=$('chkBLog');
  chkBEl.disabled=!hasB;
  chkBEl.checked=hasB;
  // When only one variant is loaded, lock the checkbox to the available file.
  // can.js selects: checked=true → fwBufB (log), checked=false → fwBufBLinear (linear).
  if(fwBufB&&fwBufBLinear)       { chkBLogEl.disabled=false; }
  else if(!fwBufB&&fwBufBLinear) { chkBLogEl.checked=false; chkBLogEl.disabled=true; }
  else if(fwBufB&&!fwBufBLinear) { chkBLogEl.checked=true;  chkBLogEl.disabled=true; }
  $('chkBLogWrap').style.display=hasB?'flex':'none';
  // ECU C
  const chkCEl=$('chkC'); chkCEl.disabled=!fwBufC; chkCEl.checked=!!fwBufC;
  // ECU D
  const chkDEl=$('chkD'); chkDEl.disabled=!fwBufD; chkDEl.checked=!!fwBufD;
  // Wizard ECU B checkboxes — same logic
  [$('wizChkLog'),$('wizNbChkLog')].forEach(el=>{
    if(!el) return;
    if(fwBufB&&fwBufBLinear)       { el.disabled=false; }
    else if(!fwBufB&&fwBufBLinear) { el.checked=false; el.disabled=true; }
    else if(fwBufB&&!fwBufBLinear) { el.checked=true;  el.disabled=true; }
    else                            { el.disabled=false; }
  });
  updateLinearMsg();
  updateCanFlashBtn();
  updateWizFileStatus();
  if(typeof updateWizFlashButtons==='function') updateWizFlashButtons();
}

// Build a guaranteed standalone ArrayBuffer from a Uint8Array slice.
function mkbuf(u8){
  const ab=new ArrayBuffer(u8.length);
  new Uint8Array(ab).set(u8);
  return ab;
}

function setSerUI(conn,name,sub){
  $('serIndicator').className='device-indicator'+(conn?' connected':'');
  $('serName').textContent=name;$('serSub').textContent=sub;
  $('btnConnectSer').textContent=conn?'Disconnect':'Connect Serial';
  $('btnTriggerDFU').disabled=conn||!!usbDev;
}

function setFwCardBusy(busy){
  ['fwFullCard','fwCompact'].forEach(id=>{
    const el=$(id);
    el.style.opacity=busy?'0.4':'';
    el.style.pointerEvents=busy?'none':'';
  });
}

function setEcuFwStatus(letter,text,color){
  const el=$('fwStatus'+letter);el.textContent=text;el.style.color=color||'';
}

function highlightFwCard(){
  const isMin=$('fwFullCard').style.display==='none';
  const card=isMin?$('fwCompact'):$('fwFullCard');
  card.classList.remove('fw-hint-pulse');
  void card.offsetWidth; // restart animation
  card.classList.add('fw-hint-pulse');
  setTimeout(()=>card.classList.remove('fw-hint-pulse'),1400);
  if(!isMin){
    let btnId=null;
    if($('fwGhPanel').style.display!=='none') btnId='btnFetch';
    else if($('fwRelPanel').style.display!=='none') btnId='btnFetchRel';
    if(btnId){
      const btn=$(btnId);
      btn.classList.add('btn-hint');
      setTimeout(()=>btn.classList.remove('btn-hint'),1400);
    }
  }
}

function expandFwCard(){
  // Called by firmware.js clearAllFw(). No-op in the new design.
}

function updateQuickFlashVisibility(){
  // No-op in all modes: the mode selector and wizard manage their own visibility.
  // The old quick-flash box no longer exists. This function is kept because
  // firmware.js calls it after successful fetches.
}

function setEcuTarget(t){
  // In expert mode the full picker stays visible. The compact bar (#ecuPickerCard)
  // is a hidden compat element kept so this branch doesn't throw if ever reached.
  if(typeof currentMode==='undefined'||currentMode!=='expert'){
    $('ecuPickerFull').style.display='none';
    $('ecuPickerCard').style.display='flex';
  }
  [['A','btnEcuA'],['BCD','btnEcuBCD'],['both','btnEcuBoth']].forEach(([s,id])=>{
    const el=$(id);
    if(el) el.className='btn '+(currentMode==='expert'?'':'btn-sm ')+(s===t?'btn-primary':'btn-ghost');
  });
  $('howToCard').style.display='';
  const showA=t==='A'||t==='both';
  const showBCD=t==='BCD'||t==='both';
  $('howToA').style.display=showA?'':'none';
  $('howToBCD').style.display=showBCD?'':'none';
  $('secA').style.display=showA?'':'none';
  $('secBCD').style.display=showBCD?'':'none';
}
