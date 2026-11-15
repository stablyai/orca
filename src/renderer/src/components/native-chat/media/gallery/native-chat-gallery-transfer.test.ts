import { expect, it } from 'vitest'
import {
  nativeChatGalleryPackets,
  NativeChatGalleryWireDecoder
} from './native-chat-gallery-transfer'

it('preserves oversized image fields through bounded UTF-8 request and result packets', () => {
  const value = {
    type: 'fixture',
    text: '😀\u0000"\n'.repeat(100_000),
    entries: Array.from({ length: 4000 }, (_, index) => ({
      source: `image-${index}.png`,
      origin: { producer: 'html-image', anchorStart: 25 }
    }))
  }
  const decoder = new NativeChatGalleryWireDecoder()
  for (const packet of nativeChatGalleryPackets(value)) {
    expect(
      new TextEncoder().encode(
        JSON.stringify({ id: 1, revision: 1, type: 'push', tokens: packet, last: false })
      ).byteLength
    ).toBeLessThanOrEqual(65536)
    decoder.push(packet)
  }
  const result = decoder.take<typeof value>()
  expect(result.text).toBe(value.text)
  expect(result.entries[3999]).toEqual({
    source: 'image-3999.png',
    origin: { producer: 'html-image', anchorStart: 25 }
  })
  expect(result.entries.length).toBe(4000)
})
