// ── Event listeners ───────────────────────────────────────────────────────
$('btnConnect').addEventListener('click',async()=>{usbDev?await doDisconnect():await doConnect()});
$('btnFlash').addEventListener('click',async()=>{setFwCardBusy(true);await doFlash();setFwCardBusy(false);});
$('btnFlashVerifyDFU').addEventListener('click',async()=>{setFwCardBusy(true);await doFlashAndVerifyDFU();setFwCardBusy(false);});
$('btnFlashCAN').addEventListener('click',async()=>{setFwCardBusy(true);await doFlashAllCAN();setFwCardBusy(false);});
$('btnVerifyCAN').addEventListener('click',async()=>{setFwCardBusy(true);await doVerifyAllCAN();setFwCardBusy(false);});
$('btnFlashVerifyCAN').addEventListener('click',async()=>{setFwCardBusy(true);await doFlashAndVerifyAllCAN();setFwCardBusy(false);});
$('chkB').addEventListener('change',onChkBChange);
['chkC','chkD'].forEach(id=>$(id).addEventListener('change',updateCanFlashBtn));
$('chkBLog').addEventListener('change',updateLinearMsg);

// Hint: highlight firmware card when hovering disabled flash buttons with no firmware loaded
['btnFlash','btnFlashVerifyDFU'].forEach(id=>{
  $(id).addEventListener('mouseenter',()=>{ if(!fwBuf) highlightFwCard(); });
});
['btnFlashCAN','btnVerifyCAN','btnFlashVerifyCAN'].forEach(id=>{
  $(id).addEventListener('mouseenter',()=>{ if(!fwBufB&&!fwBufC&&!fwBufD) highlightFwCard(); });
});

// ── Init ──────────────────────────────────────────────────────────────────
if(!navigator.usb){
  log('WebUSB not available — ECU A (DFU) cannot be flashed','log-err');
  $('btnConnect').disabled=true;$('btnTriggerDFU').disabled=true;
  if(!navigator.serial){
    setSt('Unsupported','WebUSB and Web Serial require Chrome or Edge 89+ (or Chrome for Android with USB OTG)','err');
  }else{
    log('Web Serial available ✓','log-ok');
    setSt('Limited','ECU A (DFU) unavailable — ECU B/C/D ready','');
  }
}else{
  log('WebUSB available ✓','log-ok');
  log('Equiv: dfu-util -d 0x0483:0xDF11 -c1 -a0 -D firmware.bin --dfuse-address 0x08000000:leave','log-info');
  if(!navigator.serial){
    log('Web Serial not available — ECU B/C/D and DFU trigger unavailable','log-warn');
    $('btnTriggerDFU').disabled=true;$('btnConnectSer').disabled=true;
    setSt('Limited','ECU B/C/D unavailable — ECU A (DFU) ready','');
  }else{
    log('Web Serial available ✓','log-ok');
  }
  navigator.usb.addEventListener('disconnect',e=>{
    if(usbDev&&e.device===usbDev){
      usbDev=null;dfuIface=null;
      if(!leavingDFU){
        log('Device disconnected','log-warn');
        setDevUI(false,'Disconnected','—');
        setSt('Idle','Device disconnected');
      }
    }
  });
}
