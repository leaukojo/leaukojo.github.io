// ── Web Serial — DFU trigger ──────────────────────────────────────────────
async function doTriggerDFU(){
  if(!navigator.serial){log('Web Serial not supported — use Chrome/Edge','log-err');return}
  $('btnTriggerDFU').disabled=true;
  $('btnConnectSer').disabled=true;
  $('btnTriggerDFU').classList.remove('btn-hint');
  $('connectFailMsg').style.display='none';
  const banner=$('triggerBanner');
  banner.style.display='';banner.style.color='var(--muted)';banner.textContent='Opening serial port…';
  try{
    const port=await navigator.serial.requestPort();
    await port.open({baudRate:115200});
    const w=port.writable.getWriter();
    await w.write(new TextEncoder().encode('DzZ\r'));
    await sleep(200);
    w.releaseLock();
    await port.close();
    banner.style.color='var(--accent2)';
    banner.textContent='Device rebooting into DFU — now click Connect ↑';
    log('DFU trigger sent — device rebooting…','log-ok');
    $('btnConnect').classList.add('btn-hint');
  }catch(e){
    banner.style.display='';
    banner.style.color='var(--warning)';
    if(e.name==='NotFoundError'){
      banner.textContent='No port selected — make sure RAMN is plugged in and not in use by another application.';
    }else{
      banner.textContent='Could not open serial port — check RAMN is plugged in.';
      log(`Trigger failed: ${e.message}`,'log-err');
    }
  }finally{$('btnTriggerDFU').disabled=!!usbDev||serConnected;$('btnConnectSer').disabled=false;}
}

// ── Web Serial — CAN session ──────────────────────────────────────────────
async function serialPump(){
  try{
    while(serialReader){
      const{value,done}=await serialReader.read();
      if(done)break;
      if(value)serialBuf+=new TextDecoder().decode(value);
    }
  }catch(e){}
}

async function serialReadLine(timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const cr=serialBuf.indexOf('\r');
    if(cr!==-1){
      const line=serialBuf.slice(0,cr);
      serialBuf=serialBuf.slice(cr+1);
      if(line.startsWith('d')){log('CAN error frame: '+line,'log-warn');continue;}
      // BEL (0x07) = ECU A rejected the slcan command; fall through and return the line
      // so the caller can time out naturally rather than spinning silently.
      if(line.startsWith('\x07'))log('ECU A rejected slcan command','log-err');
      return line;
    }
    await sleep(10);
  }
  return null;
}

async function serialWrite(str){
  if(!serWriter)throw new Error('Serial not connected');
  await serWriter.write(new TextEncoder().encode(str));
}

async function doConnectSerial(){
  if(!navigator.serial){log('Web Serial not supported','log-err');return}
  $('serConnectWarnMsg').style.display='none';
  try{
    serPort=await navigator.serial.requestPort();
    await serPort.open({baudRate:115200});
    serialReader=serPort.readable.getReader();
    serWriter=serPort.writable.getWriter();
    serialBuf='';serConnected=true;
    setSerUI(true,'Serial port open','115200 baud');
    log('Serial port opened ✓','log-ok');
    serialPump(); // background reader — fire-and-forget
  }catch(e){
    if(e.name==='NotFoundError'){
      $('serConnectWarnMsg').style.display='';
    }else{
      log(`Serial connect failed: ${e.message}`,'log-err');
    }
    serPort=null;serConnected=false;
    setSerUI(false,'No serial port open','—');
  }
  updateCanFlashBtn();
}

async function doDisconnectSerial(){
  try{if(serialReader)await serialReader.cancel()}catch(e){}
  try{if(serialReader)serialReader.releaseLock()}catch(e){}
  try{if(serWriter)serWriter.releaseLock()}catch(e){}
  try{if(serPort)await serPort.close()}catch(e){}
  serPort=null;serialReader=null;serWriter=null;serialBuf='';serConnected=false;
  setSerUI(false,'No serial port open','—');
  log('Serial disconnected','log-warn');
  updateCanFlashBtn();
}

// ── CAN-FD bootloader protocol (AN5405) ───────────────────────────────────
function getFDCANDLC(len){
  if(len<=8)return len;if(len<=12)return 9;if(len<=16)return 0xA;
  if(len<=20)return 0xB;if(len<=24)return 0xC;if(len<=32)return 0xD;
  if(len<=48)return 0xE;return 0xF;
}
function getFDCANPadding(len){
  if(len<=8)return '';
  const slots=[12,16,20,24,32,48,64];
  for(const s of slots)if(len<=s)return '00'.repeat(s-len);
  return '';
}
function canIsACK(line,cmd){return line==='1t'+cmd.toString(16).padStart(3,'0')+'179'}
function canIsNACK(line,cmd){return line==='1t'+cmd.toString(16).padStart(3,'0')+'11f'}

async function canSendFrame(cmd,paramsHex=''){
  const n=paramsHex.length/2;
  const frame='1t'+cmd.toString(16).padStart(3,'0')+getFDCANDLC(n).toString(16)+paramsHex+getFDCANPadding(n)+'\r';
  await serialWrite(frame);
}

async function canWaitForACK(cmd,timeoutMs=5000){
  while(true){
    const line=await serialReadLine(timeoutMs);
    if(line===null){log(`CAN timeout (cmd=${hex(cmd,2)})`,'log-err');return false;}
    if(canIsACK(line,cmd))return true;
    if(canIsNACK(line,cmd)){log('CAN NACK from target','log-err');return false;}
    // other lines: keep waiting (bus noise, etc.)
  }
}

async function canStartBootloader(letter){
  log(`Entering bootloader on ECU ${letter}…`,'log-info');
  await serialWrite('p'+letter+'\r');
  const line=await serialReadLine(5000);
  if(line===null){log(`ECU ${letter} bootloader timeout`,'log-err');return false;}
  log(`ECU ${letter} bootloader entered ✓`,'log-ok');
  return true;
}

async function canEraseMemory(){
  log('Erasing flash…','log-warn');
  await canSendFrame(CMD_ERASE,'FFFF');
  if(!await canWaitForACK(CMD_ERASE,10000))return false; // erase accepted
  if(!await canWaitForACK(CMD_ERASE,30000))return false; // erase complete
  log('Flash erased ✓','log-ok');
  return true;
}

async function canWriteChunk(addr,chunk){
  // chunk is Uint8Array, length 1–256
  const header=(addr>>>0).toString(16).padStart(8,'0')+(chunk.length-1).toString(16).padStart(2,'0');
  await canSendFrame(CMD_WRITEMEM,header);
  if(!await canWaitForACK(CMD_WRITEMEM,5000))return false;
  // Send data in 64-byte sub-frames (no ACK wait between them)
  for(let i=0;i<chunk.length;i+=64){
    const sub=chunk.subarray(i,Math.min(i+64,chunk.length));
    let hexStr='';for(const b of sub)hexStr+=b.toString(16).padStart(2,'0');
    await canSendFrame(CMD_WRITEMEM,hexStr);
  }
  if(!await canWaitForACK(CMD_WRITEMEM,5000))return false;
  return true;
}

async function canFlashFirmware(buf){
  const fw=new Uint8Array(buf);
  const n=Math.ceil(fw.byteLength/256);
  for(let i=0;i<n;i++){
    const addr=CAN_FLASH_ADDR+i*256;
    const chunk=fw.subarray(i*256,Math.min((i+1)*256,fw.byteLength));
    if(!await canWriteChunk(addr,chunk)){
      log(`Write failed at chunk ${i+1}/${n}  ${hex(addr)}`,'log-err');return false;
    }
    const pct=(i+1)/n*100;
    setProgress(`Writing ${i+1}/${n}`,pct);
    if(i===0||i%20===19||i===n-1)
      log(`  ✓ chunk ${i+1}/${n}  ${hex(addr)}  ${pct.toFixed(0)}%`,'log-ok');
  }
  return true;
}

async function canGoToApp(){
  await canSendFrame(CMD_GO,CAN_FLASH_ADDR.toString(16).padStart(8,'0'));
  if(!await canWaitForACK(CMD_GO,3000)){log('GO command refused','log-err');return false;}
  log('ECU jumped to application ✓','log-ok');
  return true;
}

async function doFlashCAN(letter,buf){
  log(`──── Flash ECU ${letter} (CAN-FD) ────`,'log-info');
  setSt(`Flashing ECU ${letter}`,'Entering bootloader…','busy');
  if(!await canStartBootloader(letter))throw new Error(`ECU ${letter} bootloader entry failed`);
  setSt(`Flashing ECU ${letter}`,'Erasing…','busy');
  setProgress('Erasing',0);
  if(!await canEraseMemory())throw new Error(`ECU ${letter} erase failed`);
  setSt(`Flashing ECU ${letter}`,'Writing…','busy');
  if(!await canFlashFirmware(buf))throw new Error(`ECU ${letter} write failed`);
  setSt(`Flashing ECU ${letter}`,'Jumping to app…','busy');
  if(!await canGoToApp())throw new Error(`ECU ${letter} GO failed`);
  await sleep(1000);
  log(`──── ECU ${letter} done ✓ ────`,'log-ok');
}

async function canResetRAMN(){
  log('Resetting RAMN…','log-warn');
  try{await serialWrite('n\r');}catch(e){}
  await sleep(300);
  await doDisconnectSerial();
  log('RAMN reset sent ✓','log-ok');
}

function getEcuBBuf(){
  return (!$('chkBLog').checked && fwBufBLinear) ? fwBufBLinear : fwBufB;
}

async function doFlashAllCAN(){
  if(!serConnected){log('Serial not connected','log-err');return;}
  $('btnFlashCAN').disabled=true;
  try{
    const ecus=[{l:'B',buf:getEcuBBuf(),chk:$('chkB')},{l:'C',buf:fwBufC,chk:$('chkC')},{l:'D',buf:fwBufD,chk:$('chkD')}];
    for(const{l,buf,chk}of ecus){
      if(!chk.checked)continue;
      if(!buf){log(`No firmware for ECU ${l} — skipping`,'log-warn');continue;}
      await doFlashCAN(l,buf);
    }
    setProgress('Complete',100);
    setSt('Done','ECU B/C/D flash complete','ok');
    log('──── CAN Flash Complete ✓ ────','log-ok');
    if($('chkReset').checked)await canResetRAMN();
  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');setSt('Error',e.message,'err');
  }finally{
    updateCanFlashBtn();
  }
}

async function canReadMemory(addr,size){
  // size: 1–256. Returns hex string of `size` bytes, or null on error.
  const header=(addr>>>0).toString(16).padStart(8,'0')+(size-1).toString(16).padStart(2,'0');
  await canSendFrame(CMD_READMEM,header);
  if(!await canWaitForACK(CMD_READMEM,5000))return null;
  // Collect data frames until final ACK
  let hexData='';
  while(true){
    const line=await serialReadLine(5000);
    if(line===null){log('Read memory timeout','log-err');return null;}
    if(canIsACK(line,CMD_READMEM))break;
    if(canIsNACK(line,CMD_READMEM)){log('Read memory NACK','log-err');return null;}
    hexData+=line.slice(6); // skip "1t{cmd3}{dlc1}" prefix
  }
  return hexData.slice(0,size*2); // trim CAN-FD padding
}

async function canVerifyFirmware(buf){
  const fw=new Uint8Array(buf);
  const n=Math.ceil(fw.byteLength/256);
  for(let i=0;i<n;i++){
    const addr=CAN_FLASH_ADDR+i*256;
    const size=Math.min(256,fw.byteLength-i*256);
    const hexData=await canReadMemory(addr,size);
    if(hexData===null){log(`Read failed at ${hex(addr)}`,'log-err');return false;}
    for(let j=0;j<size;j++){
      const expected=fw[i*256+j];
      const got=parseInt(hexData.slice(j*2,j*2+2),16);
      if(expected!==got){
        log(`Mismatch at ${hex(addr+j)}: expected ${hex(expected,2)} got ${hex(got,2)}`,'log-err');
        return false;
      }
    }
    const pct=(i+1)/n*100;
    setProgress(`Verifying ${i+1}/${n}`,pct);
    await sleep(1); // yield to browser so progress bar repaints between chunks
    if(i===0||i%20===19||i===n-1)
      log(`  ✓ chunk ${i+1}/${n}  ${hex(addr)}  ${pct.toFixed(0)}%`,'log-ok');
  }
  return true;
}

async function doVerifyCAN(letter,buf){
  log(`──── Verify ECU ${letter} (CAN-FD) ────`,'log-info');
  setSt(`Verifying ECU ${letter}`,'Entering bootloader…','busy');
  if(!await canStartBootloader(letter))throw new Error(`ECU ${letter} bootloader entry failed`);
  setSt(`Verifying ECU ${letter}`,'Reading flash…','busy');
  setProgress('Verifying',0);
  if(!await canVerifyFirmware(buf))throw new Error(`ECU ${letter} verify failed`);
  setSt(`Verifying ECU ${letter}`,'Jumping to app…','busy');
  if(!await canGoToApp())throw new Error(`ECU ${letter} GO failed`);
  await sleep(1000);
  log(`──── ECU ${letter} verified ✓ ────`,'log-ok');
}

async function doVerifyAllCAN(){
  if(!serConnected){log('Serial not connected','log-err');return;}
  $('btnVerifyCAN').disabled=true;$('btnFlashCAN').disabled=true;
  try{
    const ecus=[{l:'B',buf:getEcuBBuf(),chk:$('chkB')},{l:'C',buf:fwBufC,chk:$('chkC')},{l:'D',buf:fwBufD,chk:$('chkD')}];
    for(const{l,buf,chk}of ecus){
      if(!chk.checked)continue;
      if(!buf){log(`No firmware for ECU ${l} — skipping`,'log-warn');continue;}
      await doVerifyCAN(l,buf);
    }
    setProgress('Complete',100);
    setSt('Done','ECU B/C/D verify complete','ok');
    log('──── CAN Verify Complete ✓ ────','log-ok');
    if($('chkReset').checked)await canResetRAMN();
  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');setSt('Error',e.message,'err');
  }finally{
    updateCanFlashBtn();
  }
}

async function doFlashAndVerifyCAN(letter,buf){
  log(`──── Flash & Verify ECU ${letter} (CAN-FD) ────`,'log-info');
  setSt(`Flashing ECU ${letter}`,'Entering bootloader…','busy');
  if(!await canStartBootloader(letter))throw new Error(`ECU ${letter} bootloader entry failed`);
  setSt(`Flashing ECU ${letter}`,'Erasing…','busy');
  setProgress('Erasing',0);
  if(!await canEraseMemory())throw new Error(`ECU ${letter} erase failed`);
  setSt(`Flashing ECU ${letter}`,'Writing…','busy');
  if(!await canFlashFirmware(buf))throw new Error(`ECU ${letter} write failed`);
  setSt(`Flashing ECU ${letter}`,'Jumping to app…','busy');
  if(!await canGoToApp())throw new Error(`ECU ${letter} GO failed`);
  await sleep(1000);
  log(`ECU ${letter} flashed ✓ — verifying…`,'log-ok');
  setSt(`Verifying ECU ${letter}`,'Entering bootloader…','busy');
  if(!await canStartBootloader(letter))throw new Error(`ECU ${letter} bootloader entry failed (verify)`);
  setSt(`Verifying ECU ${letter}`,'Reading flash…','busy');
  setProgress('Verifying',0);
  if(!await canVerifyFirmware(buf))throw new Error(`ECU ${letter} verify failed`);
  setSt(`Verifying ECU ${letter}`,'Jumping to app…','busy');
  if(!await canGoToApp())throw new Error(`ECU ${letter} GO failed (verify)`);
  await sleep(1000);
  log(`──── ECU ${letter} flash & verify ✓ ────`,'log-ok');
}

async function doFlashAndVerifyAllCAN(){
  if(!serConnected){log('Serial not connected','log-err');return;}
  $('btnFlashCAN').disabled=true;$('btnVerifyCAN').disabled=true;$('btnFlashVerifyCAN').disabled=true;
  try{
    const ecus=[{l:'B',buf:getEcuBBuf(),chk:$('chkB')},{l:'C',buf:fwBufC,chk:$('chkC')},{l:'D',buf:fwBufD,chk:$('chkD')}];
    for(const{l,buf,chk}of ecus){
      if(!chk.checked)continue;
      if(!buf){log(`No firmware for ECU ${l} — skipping`,'log-warn');continue;}
      await doFlashAndVerifyCAN(l,buf);
    }
    setProgress('Complete',100);
    setSt('Done','ECU B/C/D flash & verify complete','ok');
    log('──── CAN Flash & Verify Complete ✓ ────','log-ok');
    if($('chkReset').checked)await canResetRAMN();
  }catch(e){
    log(`Fatal: ${e.message}`,'log-err');setSt('Error',e.message,'err');
  }finally{
    updateCanFlashBtn();
  }
}
