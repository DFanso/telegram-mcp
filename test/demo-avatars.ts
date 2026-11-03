// Made-up profile "photos" for the demo daemon and tests: a 160×160 PNG (Telegram's small size)
// with a diagonal gradient and a pale head-and-shoulders shape. No real photo is ever used.
import { deflateSync } from 'node:zlib'

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** A PNG going from colour `a` (top left) to `b` (bottom right), both 0xRRGGBB. */
export function demoAvatar(a: number, b: number, size = 160): Uint8Array {
  const rgb = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
  const [from, to] = [rgb(a), rgb(b)]
  const raw = new Uint8Array(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size - 2)
      const head = Math.hypot(x - size / 2, y - size * 0.4) < size * 0.17
      const body = Math.hypot((x - size / 2) / 1.3, y - size * 1.02) < size * 0.38
      const i = y * (size * 3 + 1) + 1 + x * 3
      for (let ch = 0; ch < 3; ch++) {
        const base = from[ch]! + (to[ch]! - from[ch]!) * t
        raw[i + ch] = Math.round(head || body ? base + (255 - base) * 0.7 : base)
      }
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, size)
  v.setUint32(4, size)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
