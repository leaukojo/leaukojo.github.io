// ── Firmware source ────────────────────────────────────────────────────────
const CONTENTS_API    ='https://api.github.com/repos/ToyotaInfoTech/RAMN/contents/scripts/firmware';
const CTF_CONTENTS_API='https://api.github.com/repos/ToyotaInfoTech/RAMN/contents/misc/past_CTFs';
const FW_RAW_BASE     ='https://raw.githubusercontent.com/ToyotaInfoTech/RAMN/main/scripts/firmware';
const FW_RAW_BASE_CTF ='https://raw.githubusercontent.com/ToyotaInfoTech/RAMN/main/misc/past_CTFs';
const RELEASES_API    ='https://api.github.com/repos/ToyotaInfoTech/RAMN/releases/latest';
let fwDirsLoaded=false;

function clearAllFw(){
  fwBuf=fwBufB=fwBufBLinear=fwBufC=fwBufD=null;
  ['A','B','C','D'].forEach(l=>setEcuFwStatus(l,'No firmware loaded',''));
  updateFlashBtn();syncFwCheckboxes();
  expandFwCard();
}
function clearFetchedFw(){$('fetchStatus').textContent='';clearAllFw();}
function clearRelFw(){$('relStatus').textContent='';clearAllFw();}
function clearDirFw(){$('canDirInput').value='';clearAllFw();}

function setFwSource(src){
  $('fwGhPanel').style.display  = src==='gh'  ? '' : 'none';
  $('fwRelPanel').style.display = src==='rel' ? '' : 'none';
  $('fwFilePanel').style.display= src==='file'? '' : 'none';
  [['gh','btnSrcGh'],['rel','btnSrcRel'],['file','btnSrcFile']].forEach(([s,id])=>{
    $(id).className='btn btn-sm '+(s===src?'btn-primary':'btn-ghost');
  });
  if(src==='file'){ clearFetchedFw(); clearRelFw(); }
  if(src==='gh')  { clearRelFw();     clearDirFw(); loadFwDirs(); }
  if(src==='rel') { clearFetchedFw(); clearDirFw(); }
}

async function loadFwDirs(){
  if(fwDirsLoaded){onDirChange();return;}
  const sel=$('fwDirSelect');
  sel.innerHTML='<option value="">Loading…</option>';
  try{
    const [stdItems,ctfItems]=await Promise.all([
      fetch(CONTENTS_API).then(r=>{if(!r.ok)throw new Error(`API ${r.status}`);return r.json();}),
      fetch(CTF_CONTENTS_API).then(r=>r.ok?r.json():[]).catch(()=>[])
    ]);
    const stdDirs=stdItems.filter(i=>i.type==='dir').map(i=>i.name).sort();
    const ctfDirs=ctfItems.filter(i=>i.type==='dir').map(i=>i.name).sort();
    let html='<option value="">Standard</option>'+stdDirs.map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join('');
    if(ctfDirs.length>0){
      html+='<optgroup label="⚠ CTF Firmware">'+ctfDirs.map(d=>`<option value="ctf:${esc(d)}">${esc(d)}</option>`).join('')+'</optgroup>';
    }
    sel.innerHTML=html;
    fwDirsLoaded=true;
    if(pendingCtfVariant){
      const targetVal=`ctf:${pendingCtfVariant}`;
      if(sel.querySelector(`option[value="${targetVal}"]`)){
        sel.value=targetVal;
        pendingCtfVariant=null;
        onDirChange(); // sets ctfVariant, hides log checkbox
        // Sync to wizard variant select and auto-open the Advanced panel so the user sees it
        syncWizVariant();
        const wizSel=$('wizVariantSelect');
        if(wizSel) wizSel.value=targetVal;
        const advBody=$('wizGhAdvBody');
        const advBtn=$('wizGhAdvBtn');
        if(advBody&&advBody.style.display==='none'){
          advBody.style.display='';
          if(advBtn) advBtn.textContent='Advanced ▴';
        }
        return; // onDirChange already called above
      }
      pendingCtfVariant=null;
    }
  }catch(e){
    sel.innerHTML='<option value="">Standard (offline fallback)</option>';
    log(`Could not load variant list: ${e.message}`,'log-warn');
  }
  onDirChange();
}

function onDirChange(){
  const dir=$('fwDirSelect').value;
  const isCTF=dir.startsWith('ctf:');
  ctfVariant=isCTF?dir.slice(4):null;
  $('fwDirPath').textContent=isCTF
    ?`misc/past_CTFs/${dir.slice(4)}/firmware/ECU[A-D].hex · main branch`
    :'scripts/firmware/'+(dir?`${dir}/`:'')+'ECU[A-D].bin/.hex · main branch';
  if(typeof updateCtfLogUI==='function') updateCtfLogUI();
  clearAllFw();$('fetchStatus').textContent='';
}

function parseIntelHex(text){
  // Two-pass: first find the address range, then fill a compact buffer.
  const lines=text.trim().split(/\r?\n/);
  const b=(s,i)=>parseInt(s.slice(i,i+2),16);
  let base=0,minAddr=Infinity,maxAddr=0;
  for(const line of lines){
    if(line[0]!==':') continue;
    const len=b(line,1),addr=(b(line,3)<<8)|b(line,5),type=b(line,7);
    if(type===0x01) break;
    if(type===0x04){base=((b(line,9)<<8)|b(line,11))<<16; continue;}
    if(type!==0x00||len===0) continue;
    const abs=base+addr;
    minAddr=Math.min(minAddr,abs);
    maxAddr=Math.max(maxAddr,abs+len);
  }
  const buf=new Uint8Array(maxAddr-minAddr);
  base=0;
  for(const line of lines){
    if(line[0]!==':') continue;
    const len=b(line,1),addr=(b(line,3)<<8)|b(line,5),type=b(line,7);
    if(type===0x01) break;
    if(type===0x04){base=((b(line,9)<<8)|b(line,11))<<16; continue;}
    if(type!==0x00||len===0) continue;
    const abs=base+addr-minAddr;
    for(let i=0;i<len;i++) buf[abs+i]=b(line,9+i*2);
  }
  return buf.buffer;
}

async function fetchRelease(){
  const btn=$('btnFetchRel'),st=$('relStatus');
  btn.disabled=true; st.textContent='Fetching…'; st.style.color='var(--muted)';
  fwBuf=fwBufB=fwBufBLinear=fwBufC=fwBufD=null;
  ['A','B','C','D'].forEach(l=>setEcuFwStatus(l,'…','var(--muted)'));
  try{
    const meta=await fetch(RELEASES_API).then(r=>{if(!r.ok)throw new Error(`API ${r.status}`);return r.json();});
    const tag=meta.tag_name;
    if(!/^[\w][[\w.\-/]*[\w]$/.test(tag)||tag.includes('..'))throw new Error(`Unexpected tag name: ${tag}`);
    // Fetch from raw.githubusercontent.com at the release tag — release-assets CDN has no CORS headers
    const base=`https://raw.githubusercontent.com/ToyotaInfoTech/RAMN/${tag}/scripts/firmware`;
    // ECU A: prefer .bin, fall back to .hex
    let resp=await fetch(`${base}/ECUA.bin`),isHex=false;
    if(!resp.ok){resp=await fetch(`${base}/ECUA.hex`);isHex=true;if(!resp.ok)throw new Error(`HTTP ${resp.status}`);}
    fwBuf=isHex?parseIntelHex(await resp.text()):await resp.arrayBuffer();
    const fnameA=isHex?'ECUA.hex':'ECUA.bin';
    setEcuFwStatus('A',`${fnameA}  ${(fwBuf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
    log(`Fetched ${fnameA} from release ${tag}`,'log-ok');
    // ECU B/C/D
    let ok=0;
    for(const letter of['B','C','D']){
      try{
        const r=await fetch(`${base}/ECU${letter}.hex`);
        if(!r.ok)throw new Error(`HTTP ${r.status}`);
        const buf=parseIntelHex(await r.text());
        if(letter==='B'){
          fwBufB=buf;
          setEcuFwStatus('B',`ECUB.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
          try{
            const rl=await fetch(`${base}/ECUB_LINEAR.hex`);
            if(!rl.ok)throw new Error(`HTTP ${rl.status}`);
            fwBufBLinear=parseIntelHex(await rl.text());
            log(`Fetched ECUB_LINEAR.hex from release ${tag}`,'log-ok');
            setEcuFwStatus('B',`ECUB.hex + ECUB_LINEAR.hex`,'var(--success)');
          }catch(e){fwBufBLinear=null;}
        }else if(letter==='C'){fwBufC=buf;setEcuFwStatus('C',`ECUC.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');}
        else{fwBufD=buf;setEcuFwStatus('D',`ECUD.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');}
        log(`Fetched ECU${letter}.hex from release ${tag}`,'log-ok'); ok++;
      }catch(e){setEcuFwStatus(letter,'Not found','var(--muted)');log(`ECU${letter}: ${e.message}`,'log-warn');}
    }
    st.textContent=`✓ ${tag}  ECU A + ${ok}/3 B/C/D`; st.style.color='var(--success)';
    updateQuickFlashVisibility();
  }catch(e){
    st.textContent=`Error: ${e.message}`; st.style.color='var(--danger)';
    log(`Release fetch failed: ${e.message}`,'log-err'); fwBuf=null;
    setEcuFwStatus('A','Error','var(--danger)');
  }finally{btn.disabled=false; updateFlashBtn(); syncFwCheckboxes();}
}

async function fetchFw(){
  const btn=$('btnFetch'),st=$('fetchStatus');
  btn.disabled=true; st.textContent='Fetching…'; st.style.color='var(--muted)';
  fwBuf=fwBufB=fwBufBLinear=fwBufC=fwBufD=null;
  ['A','B','C','D'].forEach(l=>setEcuFwStatus(l,'…','var(--muted)'));
  try{
    const dir=$('fwDirSelect').value;
    const isCTF=dir.startsWith('ctf:');
    let base,label,statusColor;
    if(isCTF){
      const ctfName=dir.slice(4);
      if(!/^[\w-]+$/.test(ctfName))throw new Error(`Unexpected CTF name: ${ctfName}`);
      base=`${FW_RAW_BASE_CTF}/${ctfName}/firmware`;
      label=ctfName; statusColor='var(--warning)';
    } else {
      if(dir&&!/^[\w-]+$/.test(dir))throw new Error(`Unexpected variant name: ${dir}`);
      base=dir?`${FW_RAW_BASE}/${dir}`:FW_RAW_BASE;
      label=dir||'Standard'; statusColor='var(--success)';
    }
    // ECU A: CTF only has .hex; standard prefers .bin
    let resp,isHex=false;
    if(isCTF){
      resp=await fetch(`${base}/ECUA.hex`);isHex=true;
      if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
    } else {
      resp=await fetch(`${base}/ECUA.bin`);
      if(!resp.ok){resp=await fetch(`${base}/ECUA.hex`);isHex=true;if(!resp.ok)throw new Error(`HTTP ${resp.status}`);}
    }
    fwBuf=isHex?parseIntelHex(await resp.text()):await resp.arrayBuffer();
    const fnameA=isHex?'ECUA.hex':'ECUA.bin';
    setEcuFwStatus('A',`${fnameA}  ${(fwBuf.byteLength/1024).toFixed(1)} KiB`,statusColor);
    log(`Fetched ${fnameA} [${label}]`,isCTF?'log-warn':'log-ok');
    // ECU B/C/D
    let ok=0;
    for(const letter of['B','C','D']){
      try{
        const r=await fetch(`${base}/ECU${letter}.hex`);
        if(!r.ok)throw new Error(`HTTP ${r.status}`);
        const buf=parseIntelHex(await r.text());
        if(letter==='B'){
          fwBufB=buf;
          setEcuFwStatus('B',`ECUB.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,statusColor);
          if(!isCTF){
            try{
              const rl=await fetch(`${base}/ECUB_LINEAR.hex`);
              if(!rl.ok)throw new Error(`HTTP ${rl.status}`);
              fwBufBLinear=parseIntelHex(await rl.text());
              log(`Fetched ECUB_LINEAR.hex [${label}]`,'log-ok');
              setEcuFwStatus('B',`ECUB.hex + ECUB_LINEAR.hex`,statusColor);
            }catch(e){fwBufBLinear=null;}
          }
        }else if(letter==='C'){fwBufC=buf;setEcuFwStatus('C',`ECUC.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,statusColor);}
        else{fwBufD=buf;setEcuFwStatus('D',`ECUD.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,statusColor);}
        log(`Fetched ECU${letter}.hex [${label}]`,isCTF?'log-warn':'log-ok'); ok++;
      }catch(e){setEcuFwStatus(letter,'Not found','var(--muted)');log(`ECU${letter}: ${e.message}`,'log-warn');}
    }
    const prefix=isCTF?'⚠':'✓';
    st.textContent=`${prefix} [${label}]  ECU A + ${ok}/3 B/C/D`; st.style.color=statusColor;
    updateQuickFlashVisibility();
  }catch(e){
    st.textContent=`Error: ${e.message}`; st.style.color='var(--danger)';
    log(`Fetch failed: ${e.message}`,'log-err'); fwBuf=null;
    setEcuFwStatus('A','Error','var(--danger)');
  }finally{btn.disabled=false; updateFlashBtn(); syncFwCheckboxes();}
}

// ── Local file picker ──────────────────────────────────────────────────────
$('canDirInput').addEventListener('change',e=>{
  const files=[...e.target.files];
  fwBuf=fwBufB=fwBufBLinear=fwBufC=fwBufD=null;
  ['A','B','C','D'].forEach(l=>setEcuFwStatus(l,'Not selected','var(--muted)'));
  // ECU A: prefer .bin, fall back to .hex
  const fA=files.find(f=>f.name==='ECUA.bin')||files.find(f=>f.name==='ECUA.hex');
  const fBHex=files.find(f=>f.name==='ECUB.hex');
  const fBLinear=files.find(f=>f.name==='ECUB_LINEAR.hex');
  const fC=files.find(f=>f.name==='ECUC.hex');
  const fD=files.find(f=>f.name==='ECUD.hex');
  let pending=(fA?1:0)+(fBHex?1:0)+(fBLinear?1:0)+(fC?1:0)+(fD?1:0);
  if(!pending){syncFwCheckboxes();return;}
  function onFileDone(){
    if(--pending===0){
      // Update ECU B status to reflect which variants were loaded
      if(fwBufB&&fwBufBLinear)      setEcuFwStatus('B','ECUB.hex + ECUB_LINEAR.hex','var(--success)');
      else if(!fwBufB&&fwBufBLinear) setEcuFwStatus('B',`ECUB_LINEAR.hex  ${(fwBufBLinear.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
      // (if only fwBufB, status was already set when the file was read)
      syncFwCheckboxes();
      updateQuickFlashVisibility();
    }
  }
  if(fA){
    const isHex=fA.name.endsWith('.hex');
    const r=new FileReader();
    r.onload=()=>{
      fwBuf=isHex?parseIntelHex(r.result):r.result;
      setEcuFwStatus('A',`${fA.name}  ${(fwBuf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
      log(`Loaded ${fA.name}  ${(fwBuf.byteLength/1024).toFixed(1)} KiB`,'log-ok');
      updateFlashBtn();onFileDone();
    };
    isHex?r.readAsText(fA):r.readAsArrayBuffer(fA);
  }
  if(fBHex){
    const r=new FileReader();
    r.onload=()=>{
      fwBufB=parseIntelHex(r.result);
      setEcuFwStatus('B',`ECUB.hex  ${(fwBufB.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
      log(`Loaded ECUB.hex  ${(fwBufB.byteLength/1024).toFixed(1)} KiB`,'log-ok');
      onFileDone();
    };
    r.readAsText(fBHex);
  }
  if(fBLinear){
    const r=new FileReader();
    r.onload=()=>{
      fwBufBLinear=parseIntelHex(r.result);
      log(`Loaded ECUB_LINEAR.hex  ${(fwBufBLinear.byteLength/1024).toFixed(1)} KiB`,'log-ok');
      onFileDone();
    };
    r.readAsText(fBLinear);
  }
  for(const [f,letter] of[[fC,'C'],[fD,'D']]){
    if(!f)continue;
    const r=new FileReader();
    r.onload=()=>{
      const buf=parseIntelHex(r.result);
      if(letter==='C')fwBufC=buf;else fwBufD=buf;
      setEcuFwStatus(letter,`ECU${letter}.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,'var(--success)');
      log(`Loaded ECU${letter}.hex  ${(buf.byteLength/1024).toFixed(1)} KiB`,'log-ok');
      onFileDone();
    };
    r.readAsText(f);
  }
});

// Default to GitHub source on load
setFwSource('gh');
