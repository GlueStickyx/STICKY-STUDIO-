// Minimal ZIP writer (stored, no compression) for one file. Used where a host only lets a page save
// certain file types: a WAV travels inside a .zip.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipSingle(filename: string, content: ArrayBuffer): ArrayBuffer {
  const data = new Uint8Array(content);
  const name = new TextEncoder().encode(filename);
  const crc = crc32(data);
  const out = new Uint8Array(30 + name.length + data.length + 46 + name.length + 22);
  const v = new DataView(out.buffer);
  let o = 0;
  const header = (sig: number, central: boolean) => {
    v.setUint32(o, sig, true); o += 4;
    if (central) { v.setUint16(o, 20, true); o += 2; }
    v.setUint16(o, 20, true); v.setUint16(o + 2, 0x0800, true); v.setUint16(o + 4, 0, true); // version, UTF-8 names, stored
    v.setUint16(o + 6, 0, true); v.setUint16(o + 8, 0x21, true); // time 00:00, date 1980-01-01
    v.setUint32(o + 10, crc, true); v.setUint32(o + 14, data.length, true); v.setUint32(o + 18, data.length, true);
    v.setUint16(o + 22, name.length, true); v.setUint16(o + 24, 0, true); o += 26;
    if (central) { o += 10; v.setUint32(o, 0, true); o += 4; } // comment, disk, attrs (zero), then local header offset 0
    out.set(name, o); o += name.length;
  };
  header(0x04034b50, false);
  out.set(data, o); o += data.length;
  const cdStart = o;
  header(0x02014b50, true);
  const cdSize = o - cdStart;
  v.setUint32(o, 0x06054b50, true); v.setUint16(o + 8, 1, true); v.setUint16(o + 10, 1, true);
  v.setUint32(o + 12, cdSize, true); v.setUint32(o + 16, cdStart, true);
  return out.buffer;
}
