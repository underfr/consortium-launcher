// Minimal PNG codec for player skins. Decodes any standard still PNG (every colour type, bit
// depth 1 to 16, optional Adam7 interlace, palette transparency) into 8-bit RGBA, and encodes an
// RGBA bitmap back into a PNG. Pure Node (zlib only), no Electron, no third-party library: the
// images are at most 64x64 texels, so clarity wins over speed here. Two guards keep a hostile file
// (the skin comes off the network) from costing memory: the IHDR size is checked against the
// caller's `maxPixels` before anything is allocated, and the IDAT stream is inflated with the exact
// byte bound the header implies, so a deflate bomb is refused rather than expanded.

import { crc32, deflateSync, inflateSync } from 'node:zlib'

export interface Rgba {
  width: number
  height: number
  /** width * height * 4 bytes, row-major, one R G B A quadruplet per pixel. */
  data: Uint8Array
}

export class PngError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngError'
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Samples per pixel for each PNG colour type (0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Adam7 passes: x start, y start, x step, y step. */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.equals(Buffer.from(bytes.buffer, bytes.byteOffset, 8))
}

interface Header {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlaced: boolean
}

/** Largest side accepted by any caller: the header check runs before a single byte is allocated. */
const MAX_SIDE = 16384

function parseHeader(chunk: Buffer, maxPixels: number): Header {
  if (chunk.length !== 13) throw new PngError('IHDR chunk has the wrong length')
  const width = chunk.readUInt32BE(0)
  const height = chunk.readUInt32BE(4)
  const bitDepth = chunk[8] as number
  const colorType = chunk[9] as number
  const compression = chunk[10]
  const filter = chunk[11]
  const interlace = chunk[12]
  if (width === 0 || height === 0 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new PngError(`unsupported image size ${width}x${height}`)
  }
  if (width * height > maxPixels) {
    throw new PngError(`image is ${width}x${height}, at most ${maxPixels} pixels are accepted here`)
  }
  if (!(colorType in CHANNELS)) throw new PngError(`unknown colour type ${colorType}`)
  const depthOk =
    colorType === 3
      ? [1, 2, 4, 8].includes(bitDepth)
      : colorType === 0
        ? [1, 2, 4, 8, 16].includes(bitDepth)
        : [8, 16].includes(bitDepth)
  if (!depthOk) throw new PngError(`bit depth ${bitDepth} is not valid for colour type ${colorType}`)
  if (compression !== 0 || filter !== 0) throw new PngError('unknown compression or filter method')
  if (interlace !== 0 && interlace !== 1) throw new PngError(`unknown interlace method ${interlace}`)
  return { width, height, bitDepth, colorType, interlaced: interlace === 1 }
}

/** Reverses one scanline filter in place (PNG spec 9.2); `bpp` is the filter unit in bytes. */
function unfilter(line: Uint8Array, prev: Uint8Array, type: number, bpp: number): void {
  switch (type) {
    case 0:
      return
    case 1:
      for (let i = bpp; i < line.length; i++) line[i] = (line[i]! + line[i - bpp]!) & 0xff
      return
    case 2:
      for (let i = 0; i < line.length; i++) line[i] = (line[i]! + prev[i]!) & 0xff
      return
    case 3:
      for (let i = 0; i < line.length; i++) {
        const left = i >= bpp ? line[i - bpp]! : 0
        line[i] = (line[i]! + ((left + prev[i]!) >> 1)) & 0xff
      }
      return
    case 4:
      for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0
        const b = prev[i]!
        const c = i >= bpp ? prev[i - bpp]! : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        line[i] = (line[i]! + predictor) & 0xff
      }
      return
    default:
      throw new PngError(`unknown scanline filter ${type}`)
  }
}

/** Reads the n-th sample of a scanline at its native bit depth (16-bit samples stay 16-bit). */
function sampleAt(line: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return line[index]!
  if (bitDepth === 16) return (line[index * 2]! << 8) | line[index * 2 + 1]!
  const bit = index * bitDepth
  const byte = line[bit >> 3]!
  const shift = 8 - bitDepth - (bit & 7)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

/** Scales a sample of the given bit depth to 0..255. */
function to8(value: number, bitDepth: number): number {
  if (bitDepth === 8) return value
  if (bitDepth === 16) return value >> 8
  return Math.round((value * 255) / ((1 << bitDepth) - 1))
}

interface PixelSource {
  header: Header
  palette?: Buffer
  transparency?: Buffer
}

/** Writes the RGBA of one pixel taken from a decoded scanline into `out` at `at`. */
function writePixel(src: PixelSource, line: Uint8Array, index: number, out: Uint8Array, at: number): void {
  const { bitDepth, colorType } = src.header
  const t = src.transparency
  switch (colorType) {
    case 0: {
      const v = sampleAt(line, index, bitDepth)
      const grey = to8(v, bitDepth)
      out[at] = grey
      out[at + 1] = grey
      out[at + 2] = grey
      out[at + 3] = t && t.length >= 2 && v === t.readUInt16BE(0) ? 0 : 255
      return
    }
    case 2: {
      const r = sampleAt(line, index * 3, bitDepth)
      const g = sampleAt(line, index * 3 + 1, bitDepth)
      const b = sampleAt(line, index * 3 + 2, bitDepth)
      out[at] = to8(r, bitDepth)
      out[at + 1] = to8(g, bitDepth)
      out[at + 2] = to8(b, bitDepth)
      out[at + 3] =
        t && t.length >= 6 && r === t.readUInt16BE(0) && g === t.readUInt16BE(2) && b === t.readUInt16BE(4) ? 0 : 255
      return
    }
    case 3: {
      const i = sampleAt(line, index, bitDepth)
      const p = src.palette
      if (!p || i * 3 + 2 >= p.length) throw new PngError(`palette index ${i} is out of range`)
      out[at] = p[i * 3]!
      out[at + 1] = p[i * 3 + 1]!
      out[at + 2] = p[i * 3 + 2]!
      out[at + 3] = t && i < t.length ? t[i]! : 255
      return
    }
    case 4: {
      const grey = to8(sampleAt(line, index * 2, bitDepth), bitDepth)
      out[at] = grey
      out[at + 1] = grey
      out[at + 2] = grey
      out[at + 3] = to8(sampleAt(line, index * 2 + 1, bitDepth), bitDepth)
      return
    }
    default: {
      out[at] = to8(sampleAt(line, index * 4, bitDepth), bitDepth)
      out[at + 1] = to8(sampleAt(line, index * 4 + 1, bitDepth), bitDepth)
      out[at + 2] = to8(sampleAt(line, index * 4 + 2, bitDepth), bitDepth)
      out[at + 3] = to8(sampleAt(line, index * 4 + 3, bitDepth), bitDepth)
    }
  }
}

export interface DecodeOptions {
  /**
   * Largest width x height the caller accepts (default: the codec's own 16384 x 16384 cap). Checked on the
   * IHDR chunk before any allocation, so an oversized header is refused without inflating a byte.
   */
  maxPixels?: number
}

/** Exact size of the filtered scanlines the IHDR declares: the sum over the (Adam7 or single) passes of (stride + 1) x rows. */
function rawSize(header: Header, bitsPerPixel: number): number {
  const passes = header.interlaced ? ADAM7 : [[0, 0, 1, 1] as const]
  let total = 0
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((header.width - x0) / dx)
    const passHeight = Math.ceil((header.height - y0) / dy)
    if (passWidth <= 0 || passHeight <= 0) continue
    total += (Math.ceil((passWidth * bitsPerPixel) / 8) + 1) * passHeight
  }
  return total
}

/** Decodes a PNG into 8-bit RGBA. Throws PngError for anything that is not a well-formed still PNG. */
export function decodePng(bytes: Uint8Array, options: DecodeOptions = {}): Rgba {
  const maxPixels = options.maxPixels ?? MAX_SIDE * MAX_SIDE
  if (!isPng(bytes)) throw new PngError('not a PNG file (bad signature)')
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let header: Header | undefined
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const idat: Buffer[] = []
  let offset = 8
  while (offset + 12 <= view.length) {
    const length = view.readUInt32BE(offset)
    const type = view.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > view.length) throw new PngError(`truncated ${type} chunk`)
    if (crc32(view.subarray(offset + 4, end)) !== view.readUInt32BE(end)) throw new PngError(`bad CRC in ${type} chunk`)
    const chunk = view.subarray(start, end)
    if (type === 'IHDR') {
      if (header) throw new PngError('duplicate IHDR chunk')
      header = parseHeader(chunk, maxPixels)
    } else if (!header) {
      throw new PngError(`${type} chunk before IHDR`)
    } else if (type === 'PLTE') {
      if (chunk.length === 0 || chunk.length % 3 !== 0) throw new PngError('PLTE chunk has the wrong length')
      palette = Buffer.from(chunk)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(chunk)
    } else if (type === 'IDAT') {
      idat.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }
  if (!header) throw new PngError('no IHDR chunk')
  if (idat.length === 0) throw new PngError('no image data')
  if (header.colorType === 3 && !palette) throw new PngError('palette image without a PLTE chunk')

  const { width, height, bitDepth, colorType } = header
  const bitsPerPixel = CHANNELS[colorType]! * bitDepth
  const bpp = Math.max(1, bitsPerPixel >> 3)

  // The header fixes the inflated size exactly, so zlib stops at that bound: a deflate bomb (a tiny IDAT that
  // inflates to far more than the declared scanlines) is refused instead of expanded.
  const expected = rawSize(header, bitsPerPixel)
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected })
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new PngError(`image data inflates past the ${expected} bytes a ${width}x${height} image holds (refused)`)
    }
    throw new PngError(`corrupt image data: ${err instanceof Error ? err.message : String(err)}`)
  }
  const src: PixelSource = { header, palette, transparency }
  const out = new Uint8Array(width * height * 4)
  const passes = header.interlaced ? ADAM7 : [[0, 0, 1, 1] as const]

  let pos = 0
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx)
    const passHeight = Math.ceil((height - y0) / dy)
    if (passWidth <= 0 || passHeight <= 0) continue
    const stride = Math.ceil((passWidth * bitsPerPixel) / 8)
    let prev = new Uint8Array(stride)
    for (let row = 0; row < passHeight; row++) {
      if (pos + 1 + stride > raw.length) throw new PngError('image data ends early')
      const filterType = raw[pos]!
      const line = new Uint8Array(raw.subarray(pos + 1, pos + 1 + stride))
      pos += 1 + stride
      unfilter(line, prev, filterType, bpp)
      const y = y0 + row * dy
      for (let px = 0; px < passWidth; px++) {
        writePixel(src, line, px, out, (y * width + x0 + px * dx) * 4)
      }
      prev = line
    }
  }
  return { width, height, data: out }
}

function chunk(type: string, body: Uint8Array): Buffer {
  const typeAndBody = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndBody), 0)
  return Buffer.concat([length, typeAndBody, crc])
}

/** Encodes 8-bit RGBA as a non-interlaced truecolour-with-alpha PNG (no scanline filtering). */
export function encodePng(image: Rgba): Buffer {
  const { width, height, data } = image
  if (width <= 0 || height <= 0 || data.length !== width * height * 4) {
    throw new PngError(`image data does not match a ${width}x${height} RGBA bitmap`)
  }
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // not interlaced
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}

export function pngDataUrl(png: Uint8Array): string {
  return 'data:image/png;base64,' + Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64')
}
