// ── DFU constants ─────────────────────────────────────────────────────────
const DFU_DNLOAD    = 0x01;
const DFU_UPLOAD    = 0x02;
const DFU_GETSTATUS = 0x03;
const DFU_CLRSTATUS = 0x04;
const DFU_ABORT     = 0x06;

const SNAME = ['appIDLE','appDETACH','dfuIDLE','dfuDNLOAD-SYNC','dfuDNBUSY',
               'dfuDNLOAD-IDLE','dfuMANIFEST-SYNC','dfuMANIFEST',
               'dfuMANIFEST-WAIT-RESET','dfuUPLOAD-IDLE','dfuERROR'];
const S = {
  appIDLE:0,appDETACH:1,dfuIDLE:2,dfuDNLOAD_SYNC:3,dfuDNBUSY:4,
  dfuDNLOAD_IDLE:5,dfuMANIFEST_SYNC:6,dfuMANIFEST:7,
  dfuMANIFEST_WAIT_RESET:8,dfuUPLOAD_IDLE:9,dfuERROR:10
};
const STNAME={0:'OK',1:'errTARGET',2:'errFILE',3:'errWRITE',4:'errERASE',
  5:'errCHECK_ERASED',6:'errPROG',7:'errVERIFY',8:'errADDRESS',9:'errNOTDONE',
  10:'errFIRMWARE',11:'errVENDOR',14:'errUNKNOWN',15:'errSTALLEDPKT'};

// ── App state ─────────────────────────────────────────────────────────────
let usbDev=null, dfuIface=null, xferSize=1024, fwBuf=null, pageSize=2048;
let leavingDFU=false; // true while the leave/jump sequence is in progress
let serPort=null, serialReader=null, serWriter=null, serialBuf='', serConnected=false;
let fwBufB=null, fwBufBLinear=null, fwBufC=null, fwBufD=null;

// ── CAN bootloader command codes (AN5405) ─────────────────────────────────
const CMD_GET=0x00, CMD_GO=0x21, CMD_READMEM=0x11, CMD_WRITEMEM=0x31, CMD_ERASE=0x44;
const CAN_FLASH_ADDR=0x08000000;

// ── CTF firmware support ───────────────────────────────────────────────────
let ctfVariant = null;        // null | string (original-case CTF folder name, e.g. 'ESV2024')
let pendingCtfVariant = null; // set from ?ctf= URL param; consumed by loadFwDirs() once dirs are ready
const CTF_PORTAL_URL    = 'TODO'; // swap in: link to the CTF challenge portal
const CTF_RESET_TOOL_URL = 'TODO'; // swap in: link to the post-CTF board reset tool
