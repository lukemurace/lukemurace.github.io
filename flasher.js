const log = msg => {
  document.getElementById('log').textContent += msg + '\n';
};

let port, writer;

document.getElementById('connect').onclick = async () => {
  try {
    port = await navigator.serial.requestPort({
      // optional filter, e.g. vendorId/productId
      // filters: [{ vendorId: 0x2341 }]  
    });
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    log('Port opened');
    document.getElementById('flash').disabled = false;
  } catch (e) {
    log('Error: ' + e);
  }
};

document.getElementById('flash').onclick = async () => {
  const file = document.getElementById('firmware').files[0];
  if (!file) { log('Select a file first'); return; }

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

  // optional terminator or checksum
  // await writer.write(new Uint8Array([0xff]));

  log('Upload complete, waiting for reply…');

  // read a response from the device
  const rdr = port.readable.getReader();
  const { value, done } = await rdr.read();
  if (value) log('Device replied: ' + new TextDecoder().decode(value));
  rdr.releaseLock();

  log('Closing port');
  writer.releaseLock();
  await port.close();
};
