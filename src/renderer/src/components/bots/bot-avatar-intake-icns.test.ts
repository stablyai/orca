// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ squareAvatarPng: vi.fn() }))
vi.mock('./bot-avatar-upload', () => ({ squareAvatarPng: mocks.squareAvatarPng }))

import { avatarPngFromBlob } from './bot-avatar-intake'

// Original geometric art generated with pngjs at 32, 256, and 512 px for this regression.
const MULTI_RESOLUTION_ICNS = new Uint8Array(
  readFileSync('src/renderer/src/components/bots/__fixtures__/multi-resolution.icns')
)

afterEach(() => {
  vi.clearAllMocks()
})

describe('ICNS bot avatar intake', () => {
  it('crops the largest PNG from a multi-resolution file with a generic browser MIME type', async () => {
    mocks.squareAvatarPng.mockResolvedValue('UE5HX0NST1BQRUQ')
    const input = new File([MULTI_RESOLUTION_ICNS], 'custom.icns', {
      type: 'application/octet-stream'
    })

    await expect(avatarPngFromBlob(input)).resolves.toBe('UE5HX0NST1BQRUQ')
    const source: unknown = mocks.squareAvatarPng.mock.calls[0]?.[0]
    if (!(source instanceof Blob)) {
      throw new Error('The existing PNG crop did not receive an image Blob')
    }
    const png = new Uint8Array(await source.arrayBuffer())
    const dimensions = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(source.type).toBe('image/png')
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(dimensions.getUint32(16)).toBe(512)
    expect(dimensions.getUint32(20)).toBe(512)
  })

  it('refuses an ICNS container with an invalid declared length', async () => {
    const malformed = MULTI_RESOLUTION_ICNS.slice()
    new DataView(malformed.buffer).setUint32(4, malformed.byteLength + 1)

    await expect(
      avatarPngFromBlob(new File([malformed], 'broken.icns', { type: 'image/icns' }))
    ).rejects.toMatchObject({ error: 'type' })
  })

  it('refuses non-ICNS bytes even when their name and MIME type claim ICNS', async () => {
    const input = new File([MULTI_RESOLUTION_ICNS.subarray(16)], 'not-an-icon.icns', {
      type: 'image/icns'
    })

    await expect(avatarPngFromBlob(input)).rejects.toMatchObject({ error: 'type' })
  })

  it('refuses an ICNS encoding without a supported PNG representation', async () => {
    const legacyOnly = new Uint8Array(16)
    legacyOnly.set([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 16, 0x69, 0x74, 0x33, 0x32, 0, 0, 0, 8])

    await expect(
      avatarPngFromBlob(new File([legacyOnly], 'legacy.icns', { type: 'image/icns' }))
    ).rejects.toMatchObject({ error: 'type' })
  })

  it('applies the existing source size limit before reading an ICNS container', async () => {
    const input = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.icns', {
      type: 'image/icns'
    })

    await expect(avatarPngFromBlob(input)).rejects.toMatchObject({ error: 'too_big' })
  })
})
