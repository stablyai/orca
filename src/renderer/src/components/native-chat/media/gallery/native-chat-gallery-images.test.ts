import { describe, expect, it } from 'vitest'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatMarkdownImages } from '../../markdown/native-chat-markdown-image-sources'
import {
  collectNativeChatGalleryImages,
  findNativeChatGalleryImage
} from './native-chat-gallery-images'

function message(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatBlock[]
): NativeChatMessage {
  return { id, role, blocks, timestamp: null, source: 'transcript' }
}

describe('collectNativeChatGalleryImages', () => {
  it("lists a chat's images in drawing order, skipping code and keeping repeats per row", () => {
    const messages = [
      message('u1', 'user', [
        { type: 'text', text: 'Here is the bug' },
        { type: 'image-ref', path: '/repo/pasted.png' }
      ]),
      message('a1', 'assistant', [
        { type: 'text', text: 'Not `![code](/repo/code.png)` but ![Chart](/repo/chart.png)' },
        { type: 'tool-call', name: 'Read', callId: 'c1', input: { file_path: '/repo/shot.png' } },
        { type: 'tool-result', callId: 'c1', output: '' }
      ]),
      message('a2', 'assistant', [{ type: 'text', text: 'Again ![Chart](/repo/chart.png)' }])
    ]

    const images = collectNativeChatGalleryImages(messages, nativeChatMarkdownImages)

    expect(images.map(({ kind, source, messageId }) => [kind, source, messageId])).toEqual([
      ['attachment', '/repo/pasted.png', 'u1'],
      ['markdown', '/repo/chart.png', 'a1'],
      ['attachment', '/repo/shot.png', 'a1'],
      ['markdown', '/repo/chart.png', 'a2']
    ])
    expect(findNativeChatGalleryImage(images, '/repo/chart.png', 'a2')).toBe(images[3])
  })
})
