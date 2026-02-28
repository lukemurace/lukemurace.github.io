const log = msg => {
  document.getElementById('log').textContent += msg + '\n';
};

const FLASHER_VERSION = '2026-02-28-7';
log(`Flasher version: ${FLASHER_VERSION}`);

let port, writer;
const MAGIC = new Uint8Array([0x42, 0x4c, 0x44, 0x52]); // "BLDR"
const encoder = new TextEncoder();
const EXPECTED_DEVICE_ID = 'FCCS_BOOTLOADER';
const ACK = 0x06;
const NACK = 0x15;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textDecoder = new TextDecoder();
let deviceLineBuffer = '';
let friendlyDeviceName = 'Not connected';

const setDeviceStatus = (text) => {
  friendlyDeviceName = text;
  const statusEl = document.getElementById('deviceStatus');
  if (statusEl) {
    statusEl.textContent = text;
  }
};

const appendDeviceChunk = (chunk) => {
  if (!chunk) return;
  deviceLineBuffer += chunk.replace(/\r/g, '');

  const parts = deviceLineBuffer.split('\n');
  deviceLineBuffer = parts.pop();

  for (const line of parts) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      log('Device: ' + trimmed);
    }
  }
};

const flushDeviceChunk = () => {
  const trimmed = deviceLineBuffer.trim();
  if (trimmed.length > 0) {
    log('Device: ' + trimmed);
  }
  deviceLineBuffer = '';
};

const ensureConnected = async () => {
  if (port && writer) return;
  throw new Error('Port not connected. Click Connect first.');
};

const xorChecksum = (bytes) => {
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value ^= bytes[i];
  }
  return value & 0xff;
};

const waitForAck = async (reader, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = reader.read();
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remaining));
    const result = await Promise.race([readPromise, timeoutPromise]);

    if (result.timeout) {
      return 'timeout';
    }

    if (result.done) {
      return 'disconnected';
    }

    if (result.value) {
      for (const byte of result.value) {
        if (byte === ACK) return 'ack';
        if (byte === NACK) return 'nack';
      }
    }
  }

  return 'timeout';
};

const sendFramedPayload = async (data, ackReader, frameSize = 128) => {
  for (let off = 0; off < data.length; off += frameSize) {
    const end = Math.min(off + frameSize, data.length);
    const payload = data.subarray(off, end);
    const frame = new Uint8Array(2 + payload.length + 1);

    frame[0] = payload.length & 0xff;
    frame[1] = (payload.length >> 8) & 0xff;
    frame.set(payload, 2);
    frame[frame.length - 1] = xorChecksum(payload);

    let sent = false;
    for (let retry = 0; retry < 3; retry++) {
      await writer.write(frame);
      const ackResult = await waitForAck(ackReader, 5000);
      if (ackResult === 'ack') {
        sent = true;
        break;
      }
      if (ackResult === 'disconnected') {
        throw new Error('Device disconnected during upload ACK wait');
      }
    }

    if (!sent) {
      throw new Error(`No ACK for frame at offset ${off}`);
    }
  }
};

const sendMagic = async () => {
  await ensureConnected();
  await writer.write(MAGIC);
  log('Sent magic: BLDR');
};

const verifyIdentity = async (timeoutMs = 1800) => {
  await ensureConnected();

  const nonce = Math.random().toString(36).slice(2, 10);
  const expectedReply = `I_AM ${EXPECTED_DEVICE_ID} ${nonce}`;
  const challenge = `WHOAREYOU? ${nonce}\n`;

  await writer.write(encoder.encode(challenge));

  const reader = port.readable.getReader();
  const deadline = Date.now() + timeoutMs;
  let text = '';

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const readPromise = reader.read();
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remaining));
      const result = await Promise.race([readPromise, timeoutPromise]);

      if (result.timeout || result.done) {
        break;
      }

      if (result.value) {
        const chunk = textDecoder.decode(result.value, { stream: true });
        text += chunk;
        appendDeviceChunk(chunk);

        if (text.includes(expectedReply)) {
          flushDeviceChunk();
          setDeviceStatus('FCCS Bootloader (verified)');
          return true;
        }
      }
    }

    flushDeviceChunk();
    return false;
  } finally {
    reader.releaseLock();
  }
};

const waitForBootloaderReady = async (timeoutMs = 2000) => {
  await ensureConnected();
  const reader = port.readable.getReader();
  const deadline = Date.now() + timeoutMs;
  let text = '';

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const readPromise = reader.read();
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remaining));
      const result = await Promise.race([readPromise, timeoutPromise]);

      if (result.timeout) {
        break;
      }

      if (result.done) {
        break;
      }

      if (result.value) {
        const chunk = textDecoder.decode(result.value, { stream: true });
        text += chunk;
        appendDeviceChunk(chunk);
        if (text.includes('magic OK, receiving image...')) {
          flushDeviceChunk();
          return true;
        }
      }
    }

    flushDeviceChunk();
    return false;
  } finally {
    reader.releaseLock();
  }
};

const waitForUpdateResult = async (timeoutMs = 20000) => {
  await ensureConnected();
  const reader = port.readable.getReader();
  const deadline = Date.now() + timeoutMs;
  let text = '';

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const readPromise = reader.read();
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remaining));
      const result = await Promise.race([readPromise, timeoutPromise]);

      if (result.timeout) {
        flushDeviceChunk();
        return { status: 'timeout', text };
      }

      if (result.done) {
        flushDeviceChunk();
        if (text.includes('RESULT:OK')) return { status: 'success', text };
        if (text.includes('RESULT:FAIL')) return { status: 'failure', text };
        if (text.includes('update successful')) return { status: 'success', text };
        if (text.includes('update failed') || text.includes('Update.end failed') || text.includes('Write failed') || text.includes('timeout waiting for data') || text.includes('invalid firmware size') || text.includes('missing firmware size header')) {
          return { status: 'failure', text };
        }
        return { status: 'disconnected', text };
      }

      if (result.value) {
        const chunk = textDecoder.decode(result.value, { stream: true });
        text += chunk;
        appendDeviceChunk(chunk);

        if (text.includes('RESULT:OK') || text.includes('update successful')) return { status: 'success', text };
        if (text.includes('RESULT:FAIL') || text.includes('update failed') || text.includes('Update.end failed') || text.includes('Write failed') || text.includes('timeout waiting for data') || text.includes('invalid firmware size') || text.includes('missing firmware size header')) {
          return { status: 'failure', text };
        }
      }
    }

    flushDeviceChunk();
    return { status: 'timeout', text };
  } finally {
    reader.releaseLock();
  }
};

const autoResetEsp = async () => {
  await ensureConnected();

  // Common USB-UART reset pulse pattern for ESP boards.
  // Not all adapters expose these lines in Web Serial.
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(40);
  await port.setSignals({ dataTerminalReady: true, requestToSend: false });
  await sleep(120);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(250);
  log('Auto-reset pulse sent');
};

document.getElementById('connect').onclick = async () => {
  try {
    port = await navigator.serial.requestPort({
      // optional filter, e.g. vendorId/productId
      // filters: [{ vendorId: 0x2341 }]  
    });
    await port.open({ baudRate: 115200 });
    deviceLineBuffer = '';
    writer = port.writable.getWriter();
    log('Port opened');
    setDeviceStatus('Connected (verifying identity...)');

    const verified = await verifyIdentity(1800);
    if (verified) {
      log('Identity check passed: FCCS bootloader');
    } else {
      const info = port.getInfo ? port.getInfo() : {};
      const vid = info.usbVendorId !== undefined ? `0x${info.usbVendorId.toString(16)}` : 'unknown';
      const pid = info.usbProductId !== undefined ? `0x${info.usbProductId.toString(16)}` : 'unknown';
      setDeviceStatus(`Unknown serial device (VID ${vid}, PID ${pid})`);
      log('Identity check did not verify FCCS bootloader yet (this can happen if app is running).');
    }

    document.getElementById('sendMagic').disabled = false;
    document.getElementById('flash').disabled = false;
  } catch (e) {
    log('Error: ' + e);
    setDeviceStatus('Connection failed');
  }
};

document.getElementById('sendMagic').onclick = async () => {
  try {
    const verified = await verifyIdentity(800);
    if (verified) {
      log('Identity check passed before BLDR');
    }

    try {
      await autoResetEsp();
    } catch (resetErr) {
      log('Auto-reset unavailable: ' + resetErr.message);
    }
    await sendMagic();
    const ready = await waitForBootloaderReady(2500);
    if (ready) {
      log('Bootloader handshake confirmed');
    } else {
      log('No magic OK reply yet (timing/manual reset may be needed)');
    }
  } catch (e) {
    log('Error: ' + e.message);
  }
};

document.getElementById('flash').onclick = async () => {
  const file = document.getElementById('firmware').files[0];
  if (!file) { log('Select a file first'); return; }

  try {
    await ensureConnected();

    try {
      await autoResetEsp();
    } catch (resetErr) {
      log('Auto-reset unavailable: ' + resetErr.message);
      log('Please reset the ESP32 manually now.');
    }

    const verified = await verifyIdentity(2000);
    if (!verified) {
      throw new Error('Identity check failed after reset. Not flashing unknown device.');
    }

    await sendMagic();
    const ready = await waitForBootloaderReady(2500);
    if (!ready) {
      throw new Error('Bootloader did not confirm BLDR (missing "magic OK"). Reset and try again.');
    }
    log('Bootloader ready, starting upload');

    const sizeHeader = new Uint8Array(4);
    new DataView(sizeHeader.buffer).setUint32(0, file.size, true);
    await writer.write(sizeHeader);
    log(`Sent size header: ${file.size} bytes`);

    log(`Flashing ${file.name} (${file.size} bytes)`);
    const reader = file.stream().getReader();
    const ackReader = port.readable.getReader();
    let bytesSent = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await sendFramedPayload(value, ackReader, 128);
        bytesSent += value.length;
        log(`  ${bytesSent} / ${file.size}`);
      }
    } finally {
      ackReader.releaseLock();
    }

    log('Upload complete, waiting for bootloader result…');
    const result = await waitForUpdateResult(120000);
    if (result.status === 'success') {
      log('Flash result: success');
    } else if (result.status === 'failure') {
      throw new Error('Flash result: failure (device reported update error)');
    } else if (result.status === 'disconnected') {
      log('Device disconnected/rebooted before explicit success text');
    } else {
      log('No final result line before timeout; check device behavior/logs');
    }

    log('Closing port');
    writer.releaseLock();
    await port.close();
    writer = undefined;
    port = undefined;
    setDeviceStatus('Not connected');
    document.getElementById('sendMagic').disabled = true;
    document.getElementById('flash').disabled = true;
  } catch (e) {
    log('Error: ' + e.message);
  }
};
