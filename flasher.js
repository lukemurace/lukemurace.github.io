const log = msg => {
  document.getElementById('log').textContent += msg + '\n';
};

const FLASHER_VERSION = '2026-02-28-3';
log(`Flasher version: ${FLASHER_VERSION}`);

let port, writer;
const MAGIC = new Uint8Array([0x42, 0x4c, 0x44, 0x52]); // "BLDR"
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textDecoder = new TextDecoder();

const ensureConnected = async () => {
  if (port && writer) return;
  throw new Error('Port not connected. Click Connect first.');
};

const sendMagic = async () => {
  await ensureConnected();
  await writer.write(MAGIC);
  log('Sent magic: BLDR');
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
        if (chunk.trim().length > 0) {
          log('Device: ' + chunk.trim());
        }
        if (text.includes('magic OK, receiving image...')) {
          return true;
        }
      }
    }

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
        return { status: 'timeout', text };
      }

      if (result.done) {
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
        if (chunk.trim().length > 0) {
          log('Device: ' + chunk.trim());
        }

        if (text.includes('RESULT:OK') || text.includes('update successful')) return { status: 'success', text };
        if (text.includes('RESULT:FAIL') || text.includes('update failed') || text.includes('Update.end failed') || text.includes('Write failed') || text.includes('timeout waiting for data') || text.includes('invalid firmware size') || text.includes('missing firmware size header')) {
          return { status: 'failure', text };
        }
      }
    }

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
    writer = port.writable.getWriter();
    log('Port opened');
    document.getElementById('sendMagic').disabled = false;
    document.getElementById('flash').disabled = false;
  } catch (e) {
    log('Error: ' + e);
  }
};

document.getElementById('sendMagic').onclick = async () => {
  try {
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
    let bytesSent = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
      bytesSent += value.length;
      log(`  ${bytesSent} / ${file.size}`);
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
    document.getElementById('sendMagic').disabled = true;
    document.getElementById('flash').disabled = true;
  } catch (e) {
    log('Error: ' + e.message);
  }
};
