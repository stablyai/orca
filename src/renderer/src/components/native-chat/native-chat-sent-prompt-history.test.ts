import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
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
  it('lists only prompts the user typed, oldest first', () => {
    const prompts = nativeChatSentPrompts({
      messages: [
        message('1', 'user', 'first'),
        message('2', 'assistant', 'reply'),
        message('3', 'user', 'from a peer', {
          from: { kind: 'agent', senders: [], orchestration: null }
        }),
        message('4', 'user', ''),
        message('6', 'user', '<task-notification>done</task-notification>'),
        message('7', 'user', 'prompt a parent agent gave its subagent', { agentId: 'sub-1' }),
        message('5', 'user', 'second\n\nwith a paragraph ')
      ]
    })
    expect(prompts).toEqual([
      { id: '1', prompt: 'first' },
      { id: '5', prompt: 'second\n\nwith a paragraph' }
    ])
  })

  it('recalls a structured prompt without the markers of images recall cannot bring back', () => {
    const image = { type: 'image-ref' as const, path: '/tmp/a.png' }
    const messages = [
      message('1', 'user', '', { blocks: [image, { type: 'text', text: '[Image #1] ' }] }),
      message('2', 'user', '', { blocks: [image, { type: 'text', text: 'fix [Image #1]' }] })
    ]
    expect(nativeChatSentPrompts({ messages, withoutImageMarkers: true })).toEqual([
      { id: '2', prompt: 'fix' }
    ])
    // A marker the user typed, with no image of that number, is their text.
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

  it('collapses a prompt sent back to back into its newest copy', () => {
    const prompts = nativeChatSentPrompts({
      messages: [
        message('1', 'user', 'continue'),
        message('2', 'assistant', 'ok'),
        message('3', 'user', 'continue')
      ]
    })
    expect(prompts).toEqual([{ id: '3', prompt: 'continue' }])
  })

  it('places a command the transcript holds no turn for by when it was sent', () => {
    const prompts = nativeChatSentPrompts({
      messages: [
        message('1', 'user', 'before', { timestamp: 100 }),
        message('2', 'user', 'after', { timestamp: 300 })
      ],
      commands: [
        { id: 'a', command: '/model opus', sentAt: 200 },
        { id: 'b', command: '/compact', sentAt: 400 }
      ]
    })
    expect(prompts.map((entry) => entry.prompt)).toEqual([
      'before',
      '/model opus',
      'after',
      '/compact'
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

  it('keeps its place when a new prompt lands mid-recall', () => {
    const step = stepNativeChatPromptRecall({
      direction: 'back',
      prompts: [...prompts, { id: '3', prompt: 'from another client' }],
      position: { id: '2', recalled: 'two' },
      draft: 'two'
    })
    expect(step?.draft).toBe('one')
  })
})
