const log = msg => {
  document.getElementById('log').textContent += msg + '\n';
};

const FLASHER_VERSION = '2026-02-28-15';
log(`Flasher version: ${FLASHER_VERSION}`);

let port, writer;
const MAGIC = new Uint8Array([0x42, 0x4c, 0x44, 0x52]); // "BLDR"
const encoder = new TextEncoder();
const EXPECTED_DEVICE_ID = 'GENUINE_FCCS';
const ACK = 0x06;
const NACK = 0x15;
const DEVICE_REGISTRY_URL = './device-registry.json';
const ENFORCE_REGISTRY_VERIFICATION = true;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textDecoder = new TextDecoder();
let deviceLineBuffer = '';
let friendlyDeviceName = 'Not connected';
let connectedDeviceUid = null;
let registryCache = null;

const setDeviceStatus = (text) => {
  friendlyDeviceName = text;
  const statusEl = document.getElementById('deviceStatus');
  if (statusEl) {
    statusEl.textContent = text;
  }
};

const shouldHideDeviceLine = (line) => {
  return /^ESP-ROM:/i.test(line);
};

const appendDeviceChunk = (chunk) => {
  if (!chunk) return;
  deviceLineBuffer += chunk.replace(/\r/g, '');

  const parts = deviceLineBuffer.split('\n');
  deviceLineBuffer = parts.pop();

  for (const line of parts) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      if (shouldHideDeviceLine(trimmed)) {
        continue;
      }
      log('Device: ' + trimmed);
    }
  }
};

const flushDeviceChunk = () => {
  const trimmed = deviceLineBuffer.trim();
  if (trimmed.length > 0) {
    if (!shouldHideDeviceLine(trimmed)) {
      log('Device: ' + trimmed);
    }
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

const hexToBytes = (hex) => {
  if (typeof hex !== 'string') throw new Error('Invalid sha256 field in manifest');
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Manifest sha256 must be 64 hex characters');
  }

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const base64ToBytes = (base64) => {
  if (typeof base64 !== 'string' || base64.trim().length === 0) {
    throw new Error('Invalid signature field in manifest');
  }
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const normalizeDeviceIdHex = (value) => {
  if (typeof value !== 'string') {
    throw new Error('Manifest device_id must be a string');
  }
  const normalized = value.trim().toUpperCase().replace(/^0X/, '');
  if (!/^[0-9A-F]{16}$/.test(normalized)) {
    throw new Error('Manifest device_id must be 16 hex characters (64-bit eFuse UID)');
  }
  return normalized;
};

const deviceIdHexToLittleEndianBytes = (hex) => {
  const value = BigInt('0x' + hex);
  const bytes = new Uint8Array(8);
  for (let i = 0n; i < 8n; i++) {
    bytes[Number(i)] = Number((value >> (8n * i)) & 0xffn);
  }
  return bytes;
};

const extractDeviceUidFromText = (text) => {
  const match = text.match(/UID:([0-9A-Fa-f]{16})|DEVICE_UID:([0-9A-Fa-f]{16})/);
  if (!match) return null;
  return (match[1] || match[2]).toUpperCase();
};

const loadDeviceRegistry = async () => {
  if (registryCache) return registryCache;

  const response = await fetch(`${DEVICE_REGISTRY_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Registry fetch failed (${response.status})`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Registry JSON must be an array');
  }

  const allowed = new Map();
  for (const item of data) {
    if (typeof item === 'string') {
      const uid = normalizeDeviceIdHex(item);
      allowed.set(uid, { device_id: uid, revoked: false });
      continue;
    }
    if (item && typeof item === 'object' && typeof item.device_id === 'string') {
      const uid = normalizeDeviceIdHex(item.device_id);
      const revoked = item.revoked === true;
      const enabled = item.enabled !== false;
      if (enabled) {
        allowed.set(uid, { ...item, device_id: uid, revoked });
      }
    }
  }

  registryCache = allowed;
  return allowed;
};

const verifyDeviceUidInRegistry = async (uid) => {
  const normalized = normalizeDeviceIdHex(uid);
  const registry = await loadDeviceRegistry();
  const entry = registry.get(normalized);
  if (!entry) {
    throw new Error(`Device UID ${normalized} is not in device-registry.json`);
  }
  if (entry.revoked) {
    throw new Error(`Device UID ${normalized} is revoked in device-registry.json`);
  }
  return entry;
};

const buildSignedManifestPacket = (manifest, actualFileSize) => {
  if (!Number.isInteger(manifest.version) || manifest.version < 0) {
    throw new Error('Manifest version must be a non-negative integer');
  }
  if (!Number.isInteger(manifest.size) || manifest.size <= 0) {
    throw new Error('Manifest size must be a positive integer');
  }
  if (manifest.size !== actualFileSize) {
    throw new Error(`Manifest size (${manifest.size}) does not match firmware size (${actualFileSize})`);
  }

  const hashBytes = hexToBytes(manifest.sha256);
  const signatureBytes = base64ToBytes(manifest.signature);
  const manifestDeviceId = normalizeDeviceIdHex(manifest.device_id);
  const deviceIdBytes = deviceIdHexToLittleEndianBytes(manifestDeviceId);
  if (signatureBytes.length === 0 || signatureBytes.length > 512) {
    throw new Error('Manifest signature length is invalid');
  }

  const header = new Uint8Array(4 + 4 + 32 + 8 + 2);
  const view = new DataView(header.buffer);
  view.setUint32(0, manifest.size, true);
  view.setUint32(4, manifest.version, true);
  header.set(hashBytes, 8);
  header.set(deviceIdBytes, 40);
  view.setUint16(48, signatureBytes.length, true);

  return { header, signatureBytes, hashBytes, manifestDeviceId };
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

        const parsedUid = extractDeviceUidFromText(text);
        if (parsedUid) {
          connectedDeviceUid = parsedUid;
        }

        if (text.includes(expectedReply)) {
          flushDeviceChunk();
          const suffix = connectedDeviceUid ? ` (${connectedDeviceUid})` : '';
          setDeviceStatus(`FCCS Bootloader (verified)${suffix}`);
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

const waitForManifestReady = async (timeoutMs = 5000) => {
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
        if (text.includes('manifest OK')) {
          flushDeviceChunk();
          return { status: 'ready', text };
        }
        if (
          text.includes('missing signed manifest header') ||
          text.includes('invalid signature length') ||
          text.includes('missing signature payload') ||
          text.includes('invalid firmware size') ||
          text.includes('device mismatch')
        ) {
          flushDeviceChunk();
          return { status: 'error', text };
        }
      }
    }

    flushDeviceChunk();
    return { status: 'timeout', text };
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
    if (port && writer) {
      log('Port already open');
      const verified = await verifyIdentity(1000);
      if (verified) {
        log('Identity check passed: FCCS bootloader');
      }
      return;
    }

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
      log('Identity check passed: Genuine FCCS bootloader');
      if (connectedDeviceUid) {
        try {
          const entry = await verifyDeviceUidInRegistry(connectedDeviceUid);
          const label = typeof entry.label === 'string' && entry.label.length > 0 ? ` (${entry.label})` : '';
          log(`Registry check passed for UID ${connectedDeviceUid}${label}`);
        } catch (registryErr) {
          if (ENFORCE_REGISTRY_VERIFICATION) {
            throw new Error(`Registry verification failed: ${registryErr.message}`);
          }
          log(`Warning: registry verification skipped: ${registryErr.message}`);
        }
      }
    } else {
      const info = port.getInfo ? port.getInfo() : {};
      const vid = info.usbVendorId !== undefined ? `0x${info.usbVendorId.toString(16)}` : 'unknown';
      const pid = info.usbProductId !== undefined ? `0x${info.usbProductId.toString(16)}` : 'unknown';
      setDeviceStatus(`Unknown serial device (VID ${vid}, PID ${pid})`);
      log('Identity check could not verify FCCS bootloader yet, please reboot the device and try again.');
    }

    document.getElementById('sendMagic').disabled = false;
    document.getElementById('flash').disabled = false;
  } catch (e) {
    if (e && e.name === 'NotFoundError') {
      log('Connect cancelled (no port selected)');
      return;
    }
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
  const manifestFile = document.getElementById('manifest').files[0];
  if (!file) { log('Select a file first'); return; }
  if (!manifestFile) { log('Select a signed manifest (.json) first'); return; }

  try {
    await ensureConnected();

    const manifestText = await manifestFile.text();
    const manifest = JSON.parse(manifestText);
    const signedPacket = buildSignedManifestPacket(manifest, file.size);

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
    if (!connectedDeviceUid) {
      throw new Error('Could not read target device UID from bootloader.');
    }
    try {
      const entry = await verifyDeviceUidInRegistry(connectedDeviceUid);
      const label = typeof entry.label === 'string' && entry.label.length > 0 ? ` (${entry.label})` : '';
      log(`Registry check passed for UID ${connectedDeviceUid}${label}`);
    } catch (registryErr) {
      if (ENFORCE_REGISTRY_VERIFICATION) {
        throw new Error(`Registry verification failed: ${registryErr.message}`);
      }
      log(`Warning: registry verification skipped: ${registryErr.message}`);
    }
    if (signedPacket.manifestDeviceId !== connectedDeviceUid) {
      throw new Error(`Manifest targets ${signedPacket.manifestDeviceId}, but connected device is ${connectedDeviceUid}.`);
    }

    await sendMagic();
    const ready = await waitForBootloaderReady(2500);
    if (!ready) {
      throw new Error('Bootloader did not confirm BLDR (missing "magic OK"). Reset and try again.');
    }
    log('Bootloader ready, starting upload');

    await writer.write(signedPacket.header);
    await writer.write(signedPacket.signatureBytes);
    log(`Sent signed manifest: v${manifest.version}, ${file.size} bytes, sig ${signedPacket.signatureBytes.length} bytes`);

    const manifestReady = await waitForManifestReady(22000);
    if (manifestReady.status === 'error') {
      throw new Error('Bootloader rejected signed manifest. Check device log for parse/signature details.');
    }
    if (manifestReady.status !== 'ready') {
      throw new Error('Bootloader did not confirm manifest readiness (missing "manifest OK").');
    }

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
