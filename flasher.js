const log = msg => {
  document.getElementById('log').textContent += msg + '\n';
};

let port, writer;
const MAGIC = new Uint8Array([0x42, 0x4c, 0x44, 0x52]); // "BLDR"

const ensureConnected = async () => {
  if (port && writer) return;
  throw new Error('Port not connected. Click Connect first.');
};

const sendMagic = async () => {
  await ensureConnected();
  await writer.write(MAGIC);
  log('Sent magic: BLDR');
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
    await sendMagic();
  } catch (e) {
    log('Error: ' + e.message);
  }
};

document.getElementById('flash').onclick = async () => {
  const file = document.getElementById('firmware').files[0];
  if (!file) { log('Select a file first'); return; }

  try {
    await ensureConnected();
    log('Reset the ESP32 now (if not already reset).');
    await sendMagic();
    await new Promise(resolve => setTimeout(resolve, 50));

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

    log('Upload complete, waiting for reply…');

    const rdr = port.readable.getReader();
    const { value } = await rdr.read();
    if (value) log('Device replied: ' + new TextDecoder().decode(value));
    rdr.releaseLock();

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
