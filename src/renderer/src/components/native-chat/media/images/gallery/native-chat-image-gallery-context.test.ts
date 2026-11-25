import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { nativeChatGalleryMessageId } from './native-chat-image-gallery-context'

function message(
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks']
): NativeChatMessage {
  return { id: 'row', role, blocks, timestamp: 1, source: 'transcript' }
}

const PROSE: NativeChatMessage['blocks'] = [{ type: 'text', text: 'Here is the screenshot.' }]
const WITH_TOOL: NativeChatMessage['blocks'] = [
  ...PROSE,
  { type: 'tool-call', callId: 'call', name: 'Read', input: {} }
]

it("keeps the agent's rows out while its turn works, even once a tool call follows the words", () => {
  expect(nativeChatGalleryMessageId(message('assistant', PROSE), true)).toBeNull()
  expect(nativeChatGalleryMessageId(message('assistant', WITH_TOOL), true)).toBeNull()
  expect(nativeChatGalleryMessageId(message('assistant', WITH_TOOL), false)).toBe('row')
})

it("keeps the person's own settled message in while the agent works", () => {
  expect(nativeChatGalleryMessageId(message('user', PROSE), true)).toBe('row')
})
