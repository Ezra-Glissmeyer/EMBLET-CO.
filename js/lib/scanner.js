// One scan component used everywhere: works with
//  • USB / Bluetooth barcode scanners (they type the code + Enter),
//  • typing a SKU / barcode by hand + Enter,
//  • the phone or laptop camera (html5-qrcode, Code 128 + QR), with continuous mode.
import { h, toast, modal } from './ui.js';

let audioCtx;
function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 1250 : 320; o.type = 'square'; g.gain.value = 0.05;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* no audio */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
}

/**
 * scanField({ placeholder, onScan(code) -> Promise<boolean|void>, continuous, autofocus })
 * onScan should return false if the code was not recognised (plays an error beep).
 */
export function scanField({ placeholder = 'Scan or type a barcode / SKU and press Enter', onScan, continuous = false, autofocus = false, label } = {}) {
  const input = h('input', { type: 'text', placeholder, autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, inputmode: 'text', 'aria-label': label || 'Barcode' });
  const handle = async code => {
    code = String(code || '').trim();
    if (!code) return;
    const res = await onScan(code);
    beep(res !== false);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value; input.value = ''; handle(v); }
  });
  const camBtn = h('button', { type: 'button', class: 'cam', title: 'Scan with camera', onclick: () => openCamera(handle, continuous) }, '📷 Camera');
  const wrap = h('div', { class: 'scan' }, input, camBtn);
  if (autofocus) setTimeout(() => input.focus(), 50);
  wrap.focus = () => input.focus();
  return wrap;
}

export function openCamera(onCode, continuous = false) {
  if (!window.Html5Qrcode) { toast('Camera scanner library did not load. Type the code instead.', 'err'); return; }
  if (!window.isSecureContext) { toast('The camera needs HTTPS (GitHub Pages is HTTPS). Type the code instead.', 'err'); return; }
  const id = 'cam-' + Math.random().toString(36).slice(2);
  const status = h('div', { class: 'hint' }, 'Point the camera at a barcode. Hold steady about 6–10 inches away.');
  const last = h('div', { style: { fontWeight: 600, marginTop: '6px' } });
  const box = h('div', { id, class: 'scan-video' });
  let scanner, lastCode = '', lastAt = 0, stopped = false;
  const stop = async () => {
    stopped = true;
    try { if (scanner && scanner.isScanning) await scanner.stop(); scanner && scanner.clear(); } catch { /* ignore */ }
  };
  const m = modal({ title: continuous ? 'Camera scanner (continuous)' : 'Camera scanner', body: h('div', {}, box, status, last),
                    actions: [{ label: 'Done', class: 'primary' }], onClose: stop });
  const F = window.Html5QrcodeSupportedFormats;
  scanner = new window.Html5Qrcode(id, {
    verbose: false,
    formatsToSupport: [F.CODE_128, F.QR_CODE, F.CODE_39, F.EAN_13, F.UPC_A],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
  const onOk = async text => {
    const now = Date.now();
    if (text === lastCode && now - lastAt < 1800) return;   // de-bounce the same code
    lastCode = text; lastAt = now;
    last.textContent = '✔ ' + text;
    if (!continuous) { await stop(); m.close(); }
    await onCode(text);
  };
  const cfg = { fps: 12, qrbox: (w, hgt) => ({ width: Math.min(w * 0.9, 420), height: Math.min(hgt * 0.5, 180) }), aspectRatio: 1.6 };
  scanner.start({ facingMode: 'environment' }, cfg, onOk, () => {})
    .catch(() => scanner.start({ facingMode: 'user' }, cfg, onOk, () => {}))
    .catch(err => { if (!stopped) status.textContent = 'Could not open a camera: ' + (err?.message || err) + '. Allow camera access, or type the code.'; });
}
