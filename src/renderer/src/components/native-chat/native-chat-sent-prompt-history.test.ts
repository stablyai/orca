import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import {
  nativeChatSentPrompts,
  stepNativeChatPromptRecall
} from './native-chat-sent-prompt-history'

function message(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    blocks: text ? [{ type: 'text', text }] : [],
    timestamp: null,
    source: 'transcript',
    ...extra
  }
}

describe('nativeChatSentPrompts', () => {
  it('recalls a structured prompt without the markers of images recall cannot bring back', () => {
    const image = { type: 'image-ref' as const, path: '/tmp/a.png' }
    const messages = [
      message('1', 'user', '', { blocks: [image, { type: 'text', text: '[Image #1] ' }] }),
      message('2', 'user', '', { blocks: [image, { type: 'text', text: 'fix [Image #1]' }] })
    ]
    expect(nativeChatSentPrompts({ messages, withoutImageMarkers: true })).toEqual([
      { id: '2', prompt: 'fix' }
    ])
    const typed = [
      message('3', 'user', '[Image #1]'),
      message('4', 'user', '', { blocks: [image, { type: 'text', text: 'not [Image #2]' }] })
    ]
    expect(nativeChatSentPrompts({ messages: typed, withoutImageMarkers: true })).toEqual([
      { id: '3', prompt: '[Image #1]' },
      { id: '4', prompt: 'not [Image #2]' }
    ])
    // A terminal chat's transcript text is the agent's own, markers included.
    expect(nativeChatSentPrompts({ messages }).map(({ prompt }) => prompt)).toEqual([
      '[Image #1]',
      'fix [Image #1]'
    ])
  })
})

describe('stepNativeChatPromptRecall', () => {
  const prompts = [
    { id: '1', prompt: 'one' },
    { id: '2', prompt: 'two' }
  ]

  it('keeps its place when the recalled echo is replaced by its transcript turn', () => {
    const step = stepNativeChatPromptRecall({
      direction: 'back',
      prompts,
      position: { id: 'pending:9', recalled: 'two' },
      draft: 'two'
    })
    expect(step?.draft).toBe('one')
  })
})
