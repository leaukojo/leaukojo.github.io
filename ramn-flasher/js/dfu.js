// ── Descriptor parsing ────────────────────────────────────────────────────
// Search an extras blob (ArrayBuffer, DataView, or Uint8Array) for a DFU
// functional descriptor (bDescriptorType=0x21) and return its fields.
function parseExtras(extras){
  try{
    if(!extras||extras.byteLength<9)return null;
    // extras may be ArrayBuffer, DataView, or Uint8Array depending on Chrome version.
    const ab=extras.buffer||extras;
    const base=extras.byteOffset||0;
    const buf=new Uint8Array(ab,base,extras.byteLength);
    for(let i=0;i+8<buf.byteLength;i++){
      if(buf[i+1]===0x21&&buf[i]>=9){
        const v=new DataView(ab,base+i,buf[i]);
        return{bmAttr:v.getUint8(2),wDetach:v.getUint16(3,true),
               wTransferSize:v.getUint16(5,true),bcdDFU:v.getUint16(7,true)};
      }
    }
  }catch(e){}
  return null;
}

// Chrome sometimes puts the DFU functional descriptor in alt.extras and sometimes
// in ifc.extras — try both.
function parseFuncDesc(alt, ifc){
  return parseExtras(alt&&alt.extras) || parseExtras(ifc&&ifc.extras) || null;
}

function parsePageSize(altName, targetAddr){
  try{
    const m=altName.match(/\/0x([0-9a-fA-F]+)\/(.+)/);
    if(!m)return null;
    let addr=parseInt(m[1],16);
    for(const seg of m[2].split(',')){
      const sm=seg.trim().match(/(\d+)\*(\d+)(.)(.)/i);
      if(!sm)continue;
      const count=parseInt(sm[1]);
      let size=parseInt(sm[2]);
      const unit=sm[3].toUpperCase();
      if(unit==='K')size*=1024;
      else if(unit==='M')size*=1024*1024;
      const end=addr+count*size;
      if(targetAddr>=addr&&targetAddr<end)return size;
      addr=end;
    }
  }catch(e){}
  return null;
}

// ── WebUSB connect / disconnect ───────────────────────────────────────────
async function doConnect(){
  const vid=0x0483,pid=0xDF11,cfgNum=1,altNum=0;
  try{
    usbDev=await navigator.usb.requestDevice({filters:[{vendorId:vid,productId:pid}]});
    await usbDev.open();
    log(`Opened: ${usbDev.manufacturerName||'?'} / ${usbDev.productName||'?'}`,'log-ok');
    log(`VID:PID ${hex(usbDev.vendorId,4)}:${hex(usbDev.productId,4)}  serial=${usbDev.serialNumber||'n/a'}`,'log-info');
    await usbDev.selectConfiguration(cfgNum);

    let foundIface=null;
    for(const cfg of usbDev.configurations)
      for(const ifc of cfg.interfaces)
        for(const alt of ifc.alternates)
          if(alt.interfaceClass===0xFE&&alt.interfaceSubclass===0x01){
            log(`  DFU iface=${ifc.interfaceNumber} alt=${alt.alternateSetting} proto=${alt.interfaceProtocol} name="${alt.interfaceName||''}"`, 'log-info');
            if(alt.alternateSetting===altNum&&!foundIface) foundIface={ifc,alt};
          }

    if(!foundIface) throw new Error(`No DFU interface for alt=${altNum}`);
    dfuIface=foundIface.ifc;

    const fd=parseFuncDesc(foundIface.alt, foundIface.ifc);
    if(fd){
      xferSize=fd.wTransferSize||1024;
      log(`FuncDesc: wTransferSize=${xferSize} bcdDFU=${hex(fd.bcdDFU,4)} bmAttr=${hex(fd.bmAttr,2)}`,'log-info');
      $('devInfo').style.display='';
      $('infoXfer').textContent=xferSize+' B';
      $('infoBcd').textContent=hex(fd.bcdDFU,4);
      $('infoAttr').textContent=hex(fd.bmAttr,2);
    } else {
      log(`No functional descriptor — using xferSize=${xferSize}`,'log-warn');
    }

    const altName=foundIface.alt.interfaceName||'';
    $('infoAlt').textContent=altName||'—';
    if(altName) log(`Alt name: "${altName}"`,'log-info');

    pageSize=parsePageSize(altName, 0x08000000) || 2048;
    log(`Page size: ${pageSize} bytes`,'log-info');

    await usbDev.claimInterface(dfuIface.interfaceNumber);
    await usbDev.selectAlternateInterface(dfuIface.interfaceNumber,altNum);
    log(`Interface ${dfuIface.interfaceNumber} claimed ✓`,'log-ok');

    setDevUI(true,
      `${usbDev.manufacturerName||'?'} / ${usbDev.productName||'?'}`,
      `${hex(usbDev.vendorId,4)}:${hex(usbDev.productId,4)} — iface ${dfuIface.interfaceNumber}`);
    setSt('Connected','Ready','ok');
    $('btnConnect').classList.remove('btn-hint');
    $('connectFailMsg').style.display='none';
    $('triggerBanner').style.display='none';
  }catch(e){
    log(`Connect failed: ${e.message}`,'log-err');
    setSt('Error',e.message,'err');
    usbDev=null;dfuIface=null;
    setDevUI(false,'No device connected','—');
    $('btnConnect').classList.remove('btn-hint');
    $('connectFailMsg').style.display='';
    if(e.name==='NotFoundError') $('btnTriggerDFU').classList.add('btn-hint');
  }
}

async function doDisconnect(){
  try{if(dfuIface)await usbDev.releaseInterface(dfuIface.interfaceNumber)}catch(e){}
  try{await usbDev.close()}catch(e){}
  usbDev=null;dfuIface=null;
  setDevUI(false,'No device connected','—');
  $('devInfo').style.display='none';
  setSt('Idle','Connect a device to begin');
  log('Disconnected','log-warn');
}

// ── Raw USB class transfers ───────────────────────────────────────────────
// All data arguments must be ArrayBuffer (not TypedArray) to avoid
// Chrome WebUSB sending the full backing buffer instead of the slice.

async function rawOut(req, val, ab){
  const r=await usbDev.controlTransferOut({
    requestType:'class', recipient:'interface',
    request:req, value:val, index:dfuIface.interfaceNumber
  }, ab);
  return r.status; // 'ok' | 'stall' | 'babble'
}

async function rawIn(req, val, len){
  const r=await usbDev.controlTransferIn({
    requestType:'class', recipient:'interface',
    request:req, value:val, index:dfuIface.interfaceNumber
  }, len);
  if(r.status!=='ok') throw new Error(`ctrlIn stall/err req=${req} status=${r.status}`);
  return r.data; // DataView
}

// ── DFU protocol ──────────────────────────────────────────────────────────
async function getstatus(){
  const d=await rawIn(DFU_GETSTATUS,0,6);
  if(d.byteLength<6) throw new Error(`GETSTATUS: short ${d.byteLength}B`);
  const status=d.getUint8(0);
  const pollMs=d.getUint8(1)|(d.getUint8(2)<<8)|(d.getUint8(3)<<16);
  const state=d.getUint8(4);
  return{status, statusName:STNAME[status]||hex(status,2),
         pollMs, state, stateName:SNAME[state]||`??(${state})`};
}

async function clrstatus(){ await rawOut(DFU_CLRSTATUS,0,new ArrayBuffer(0)) }
async function doAbort()  { await rawOut(DFU_ABORT,0,new ArrayBuffer(0)) }

// Send a DNLOAD and return the transfer status ('ok' or 'stall').
// Does NOT throw on stall — caller decides how to handle it.
async function dnload(blkNum, ab){
  const status = await rawOut(DFU_DNLOAD, blkNum, ab);
  if(status==='stall'){
    log(`  DNLOAD stall (blk=${blkNum} len=${ab.byteLength}) — reading device error…`,'log-warn');
  }
  return status;
}

// Poll until out of dfuDNLOAD-SYNC / dfuDNBUSY. Returns the final status struct.
// Only logs when the device actually needed multiple polls — avoids per-chunk DOM writes.
async function pollUntilIdle(tag){
  let st=await getstatus();
  let polls=0;
  while((st.state===S.dfuDNLOAD_SYNC||st.state===S.dfuDNBUSY)&&++polls<600){
    await sleep(st.pollMs||2);
    st=await getstatus();
  }
  if(polls>=600) throw new Error(`poll watchdog [${tag}]`);
  if(polls>1) log(`    [${tag}] settled after ${polls} polls — ${st.stateName}`,'log-info');
  return st;
}

// Bring device to dfuIDLE regardless of starting state.
// Also handles unknown/corrupt states (e.g. after an oversized chunk overwrote
// the device's internal DFU state machine) by always trying clrstatus first.
async function toIdle(){
  let st=await getstatus();
  log(`toIdle: current=${st.stateName}`,'log-info');
  if(st.state===S.dfuIDLE)return;
  // clrstatus is only spec-valid from dfuERROR, but also helps devices stuck in
  // an unknown state (SNAME[x] === undefined for any x outside 0-10).
  if(st.state===S.dfuERROR||!SNAME[st.state]){
    try{await clrstatus()}catch(e){}
    await sleep(10);
    st=await getstatus();
    if(st.state===S.dfuIDLE){log('toIdle ✓','log-ok');return;}
  }
  await doAbort();await sleep(5);
  st=await getstatus();
  if(st.state===S.dfuERROR||!SNAME[st.state]){
    try{await clrstatus()}catch(e){}
    await sleep(10);
    st=await getstatus();
  }
  if(st.state!==S.dfuIDLE) throw new Error(`Cannot reach dfuIDLE: ${st.stateName}`);
  log(`toIdle ✓`,'log-ok');
}

// ── DfuSe special command (wBlockNum=0) ───────────────────────────────────
// Send command, poll until done (leaves device in dfuDNLOAD-IDLE).
async function specialCmd(name, payloadU8){
  const ab=mkbuf(payloadU8);
  const txStatus=await dnload(0, ab);
  if(txStatus==='stall'){
    const st=await getstatus().catch(()=>null);
    throw new Error(`${name} DNLOAD stalled: device=${st?`${st.statusName}/${st.stateName}`:'unknown'}`);
  }
  const st=await pollUntilIdle(name);
  if(st.state===S.dfuERROR)
    throw new Error(`${name} failed: ${st.statusName}`);
  // device is now in dfuDNLOAD-IDLE
}

async function setAddress(addr){
  log(`DfuSe SetAddress ${hex(addr)}`,'log-info');
  await specialCmd('SetAddress', new Uint8Array([
    0x21, addr&0xFF, (addr>>8)&0xFF, (addr>>16)&0xFF, (addr>>24)&0xFF
  ]));
}

async function erasePage(addr){
  await specialCmd('ErasePage', new Uint8Array([
    0x41, addr&0xFF, (addr>>8)&0xFF, (addr>>16)&0xFF, (addr>>24)&0xFF
  ]));
}

async function massErase(){
  log(`DfuSe Mass Erase…`,'log-warn');
  const txStatus=await dnload(0, mkbuf(new Uint8Array([0x41])));
  if(txStatus==='stall') throw new Error('Mass erase DNLOAD stalled');
  let st=await getstatus();
  log(`  MassErase: ${st.stateName} poll=${st.pollMs}ms`,'log-warn');
  // STM32F4 lies — reports 100ms but actually needs up to 32s
  const timeout = st.pollMs===100 ? 35000 : (st.pollMs||500);
  let guard=120;
  while((st.state===S.dfuDNLOAD_SYNC||st.state===S.dfuDNBUSY)&&--guard>0){
    await sleep(timeout);
    st=await getstatus();
    log(`  MassErase: ${st.stateName}`,'log-warn');
  }
  if(st.state===S.dfuERROR) throw new Error(`Mass erase failed: ${st.statusName}`);
  if(guard<=0) throw new Error('Mass erase watchdog');
  log(`Mass Erase done ✓`,'log-ok');
  // device in dfuDNLOAD-IDLE — caller must abort to dfuIDLE
}

// Flash without leaving DFU, then verify, then leave.
async function doFlashAndVerifyDFU(){
  if(!usbDev||!fwBuf)return;
  const addr=0x08000000;

  $('btnFlash').disabled=true;
  $('btnFlashVerifyDFU').disabled=true;
  $('btnConnect').disabled=true;

  try{
    const fw=new Uint8Array(fwBuf);
    const nChunks=Math.ceil(fw.byteLength/xferSize);
    log('──── Flash+Verify Start ────','log-info');
    log(`addr=${hex(addr)}  size=${fw.byteLength}B  xfer=${xferSize}B`,'log-info');

    // ── Erase ──────────────────────────────────────────────────────────────
    setSt('Preparing','Resetting…','busy');
    await toIdle();
    setSt('Erasing','Mass erase…','busy');
    setProgress('Erasing',0);
    await massErase();
    await doAbort();await sleep(5);
    const st0=await getstatus();
    if(st0.state===S.dfuERROR){await clrstatus();await sleep(10);}
    await toIdle();

    // ── Write ───────────────────────────────────────────────────────────────
    setSt('Writing','Starting…','busy');
    setProgress('Writing',0);
    await setAddress(addr);
    for(let i=0;i<nChunks;i++){
      const off=i*xferSize;
      const len=Math.min(xferSize,fw.byteLength-off);
      const ab=new ArrayBuffer(len);
      new Uint8Array(ab).set(fw.subarray(off,off+len));
      const txStatus=await dnload(2+i,ab);
      if(txStatus==='stall'){
        const errSt=await getstatus().catch(()=>null);
        throw new Error(`Write stall [chunk${i}]: ${errSt?.statusName??'unknown'}`);
      }
      const st=await pollUntilIdle(`chunk${i}`);
      if(st.state!==S.dfuDNLOAD_IDLE)
        throw new Error(`Write failed [chunk${i}]: state=${st.stateName} status=${st.statusName}`);
      const pct=(i+1)/nChunks*100;
      setProgress(`Writing ${i+1}/${nChunks}`,pct);
      setSt('Writing',`${i+1}/${nChunks} @ ${hex(addr+off)} (${pct.toFixed(0)}%)`,'busy');
      if(i===0||i%10===9||i===nChunks-1)
        log(`  ✓ chunk ${i+1}/${nChunks}  ${hex(addr+off)}  ${pct.toFixed(0)}%`,'log-ok');
    }
    log(`All ${nChunks} chunks written ✓`,'log-ok');

    // ── Verify ──────────────────────────────────────────────────────────────
    // Abort from dfuDNLOAD-IDLE back to dfuIDLE, then set address and upload.
    await doAbort();await sleep(5);
    const stAfterWrite=await getstatus();
    if(stAfterWrite.state===S.dfuERROR){await clrstatus();await sleep(10);}
    await toIdle();
    await setAddress(addr);
    await doAbort();await sleep(5);
    const stAfterSetAddr=await getstatus();
    if(stAfterSetAddr.state===S.dfuERROR){await clrstatus();await sleep(10);}
    await toIdle();

    setSt('Verifying','Reading back…','busy');
    setProgress('Verifying',0);
    let mismatch=0;
    for(let i=0;i<nChunks;i++){
      const off=i*xferSize;
      const len=Math.min(xferSize,fw.byteLength-off);
      const dv=await rawIn(DFU_UPLOAD, 2+i, len);
      if(dv.byteLength!==len) throw new Error(`Read short: chunk${i} expected ${len}B got ${dv.byteLength}B`);
      const read=new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength);
      for(let b=0;b<len;b++){
        if(read[b]!==fw[off+b]){mismatch++;break;}
      }
      const pct=(i+1)/nChunks*100;
      setProgress(`Verifying ${i+1}/${nChunks}`,pct);
      setSt('Verifying',`${i+1}/${nChunks} @ ${hex(addr+off)} (${pct.toFixed(0)}%)`,'busy');
      if(i%10===9||i===nChunks-1) await sleep(1); // yield to browser for repaint every 10 chunks
      if(i===0||i%10===9||i===nChunks-1)
        log(`  ✓ read chunk ${i+1}/${nChunks}  ${hex(addr+off)}  ${pct.toFixed(0)}%`,'log-ok');
    }
    try{await doAbort();await sleep(5);}catch(e){}

    if(mismatch>0){
      log(`Verify FAILED: ${mismatch} chunk(s) mismatched`,'log-err');
      setSt('Verify Failed',`${mismatch} chunk(s) mismatched`,'err');
      $('devIndicator').className='device-indicator error';
      return;
    }
    log(`Verify ✓ — all chunks match`,'log-ok');

    // ── Leave ───────────────────────────────────────────────────────────────
    setSt('Leaving DFU','Jumping to app…','busy');
    log(`Leave: SetAddress(${hex(addr)}) → DNLOAD(0,0)`,'log-info');
    leavingDFU=true;
    try{
      await toIdle();
      await setAddress(addr);
      await dnload(0, new ArrayBuffer(0));
      await sleep(5);
      await getstatus().catch(()=>{});
    }catch(e){
      if(usbDev) log(`Leave error: ${e.message}`,'log-warn');
    }
    leavingDFU=false;
    await sleep(400);
    if(usbDev){
      try{await usbDev.releaseInterface(dfuIface.interfaceNumber)}catch(e){}
      try{await usbDev.close()}catch(e){}
    }
    usbDev=null;dfuIface=null;
    setDevUI(false,'Device reset — jumped to app','—');
    log('Jumped to application ✓','log-ok');

    setProgress('Complete',100);
    setSt('Done',`${(fw.byteLength/1024).toFixed(1)} KiB flashed and verified`,'ok');
    log('──── Flash+Verify Complete ✓ ────','log-ok');

  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');
    console.error(e);
    try{const st=await getstatus();log(`Device state at error: ${st.stateName}/${st.statusName}`,'log-err');}catch(e2){}
    setSt('Error',e.message,'err');
    $('devIndicator').className='device-indicator error';
  }finally{
    const ready=!!(usbDev&&fwBuf);
    $('btnFlash').disabled=!ready;
    $('btnFlashVerifyDFU').disabled=!ready;
    $('btnConnect').disabled=false;
  }
}

// ── Main flash routine ────────────────────────────────────────────────────
async function doFlash(){
  if(!usbDev||!fwBuf)return;
  const addr=0x08000000;

  $('btnFlash').disabled=true;
  $('btnConnect').disabled=true;

  try{
    const fw=new Uint8Array(fwBuf);
    const nChunks=Math.ceil(fw.byteLength/xferSize);
    log('──── Flash Start ────','log-info');
    log(`addr=${hex(addr)}  size=${fw.byteLength}B  xfer=${xferSize}B  page=${pageSize}B`,'log-info');

    // ── 1. Reset to dfuIDLE ───────────────────────────────────────────────
    setSt('Preparing','Resetting…','busy');
    await toIdle();

    // ── 2. Erase ──────────────────────────────────────────────────────────
    setSt('Erasing','Mass erase…','busy');
    setProgress('Erasing',0);
    await massErase();
    await doAbort();await sleep(5);
    const stAfterErase=await getstatus();
    log(`Post-mass-erase: ${stAfterErase.stateName}`,'log-info');
    if(stAfterErase.state===S.dfuERROR){await clrstatus();await sleep(10);}
    await toIdle();

    // ── 3. Write ──────────────────────────────────────────────────────────
    setSt('Writing','Starting…','busy');
    log(`Writing ${nChunks} chunks…`,'log-info');

    // Set base address once. Subsequent chunks use wBlockNum=2+i so the
    // bootloader auto-computes the target address (AN3156 §5.1: address =
    // startAddress + (wBlockNum−2) × wTransferSize). No setAddress per chunk needed.
    setProgress('Writing',0);
    await setAddress(addr);

    for(let i=0;i<nChunks;i++){
      const off=i*xferSize;
      const chunkAddr=addr+off;
      const len=Math.min(xferSize,fw.byteLength-off);

      const ab=new ArrayBuffer(len);
      new Uint8Array(ab).set(fw.subarray(off,off+len));
      const txStatus=await dnload(2+i,ab);
      if(txStatus==='stall'){
        const errSt=await getstatus().catch(()=>null);
        throw new Error(`Write stall [chunk${i}]: ${errSt?.statusName??'unknown'}`);
      }

      const st=await pollUntilIdle(`chunk${i}`);
      if(st.state!==S.dfuDNLOAD_IDLE)
        throw new Error(`Write failed [chunk${i}]: state=${st.stateName} status=${st.statusName}`);

      const pct=(i+1)/nChunks*100;
      setProgress(`Writing ${i+1}/${nChunks}`,pct);
      setSt('Writing',`${i+1}/${nChunks} @ ${hex(chunkAddr)} (${pct.toFixed(0)}%)`,'busy');
      if(i===0||i%10===9||i===nChunks-1)
        log(`  ✓ chunk ${i+1}/${nChunks}  ${hex(chunkAddr)}  ${pct.toFixed(0)}%`,'log-ok');
    }
    log(`All ${nChunks} chunks written ✓`,'log-ok');

    // ── 4. Leave ─────────────────────────────────────────────────────────
    // Per DfuSe AN3156, leaving DFU and booting the application requires:
    //   1. SET_ADDRESS to the application start address  (wBlockNum=0, special cmd)
    //   2. Zero-length DNLOAD at wBlockNum=0             (triggers jump)
    // The address_pointer after the last chunk write points to the last chunk's
    setSt('Leaving DFU','Jumping to app…','busy');
    log(`Leave: SetAddress(${hex(addr)}) → DNLOAD(0,0) → device reset`,'log-info');
    leavingDFU=true;
    try{
      await setAddress(addr);               // re-set address_pointer to app start
      await dnload(0, new ArrayBuffer(0));  // wBlockNum=0, wLength=0 = DfuSe jump trigger
      await sleep(5);
      await getstatus().catch(()=>{});      // device resets here — disconnect expected
    }catch(e){
      if(usbDev) log(`Leave error: ${e.message}`,'log-warn');
    }
    leavingDFU=false;
    await sleep(400);
    if(usbDev){
      try{await usbDev.releaseInterface(dfuIface.interfaceNumber)}catch(e){}
      try{await usbDev.close()}catch(e){}
    }
    usbDev=null;dfuIface=null;
    setDevUI(false,'Device reset — jumped to app','—');
    log('Jumped to application ✓','log-ok');

    setProgress('Complete',100);
    setSt('Done',`${(fw.byteLength/1024).toFixed(1)} KiB flashed`,'ok');
    log('──── Flash Complete ✓ ────','log-ok');

  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');
    console.error(e);
    try{
      const st=await getstatus();
      log(`Device state at error: ${st.stateName} / ${st.statusName}`,'log-err');
    }catch(e2){}
    setSt('Error',e.message,'err');
    $('devIndicator').className='device-indicator error';
  }finally{
    $('btnFlash').disabled=!(usbDev&&fwBuf);
    $('btnConnect').disabled=false;
  }
}
