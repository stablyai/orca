import { describe, expect, it } from 'vitest'
import { avatarPngFromIcns } from './bot-avatar-icns'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

// Only the signature and IHDR are read when picking an entry.
function pngHeader(side: number): number[] {
  const bytes = new Uint8Array(24)
  const view = new DataView(bytes.buffer)
  bytes.set(PNG_SIGNATURE, 0)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, side)
  view.setUint32(20, side)
  return Array.from(bytes)
}

function icns(entries: [string, number[]][]): Uint8Array<ArrayBuffer> {
  const body = entries.flatMap(([type, data]) => {
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, data.length + 8)
    return [...Array.from(type, (c) => c.charCodeAt(0)), ...length, ...data]
  })
  const bytes = new Uint8Array(8 + body.length)
  bytes.set([0x69, 0x63, 0x6e, 0x73], 0)
  new DataView(bytes.buffer).setUint32(4, bytes.length)
  bytes.set(body, 8)
  return bytes
}

describe('avatarPngFromIcns', () => {
  it('picks the smallest PNG entry that covers the 512 px crop', () => {
    const bundle = icns([
      ['ic04', [0x41, 0x52, 0x47, 0x42, 0, 0, 0, 0]],
      ['ic08', pngHeader(256)],
      ['ic10', pngHeader(1024)],
      ['ic09', pngHeader(512)]
    ])

    expect(Array.from(avatarPngFromIcns(bundle) ?? [])).toEqual(pngHeader(512))
  })

  it('refuses a bundle whose entry runs past the file', () => {
    const bundle = icns([['ic09', pngHeader(512)]])
    new DataView(bundle.buffer).setUint32(12, 1000)

    expect(avatarPngFromIcns(bundle)).toBeNull()
  })
})
