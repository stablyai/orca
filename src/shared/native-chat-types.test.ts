import { describe, it, expect } from 'vitest'
import {
  isAgentNoticeMessage,
  isTextBlock,
  isToolCallBlock,
  isToolResultBlock,
  isImageRefBlock,
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatBlock,
  type NativeChatMessage
} from './native-chat-types'

const textBlock: NativeChatBlock = { type: 'text', text: 'hello' }
const toolCallBlock: NativeChatBlock = { type: 'tool-call', name: 'Edit', input: { path: 'a' } }
const toolResultBlock: NativeChatBlock = { type: 'tool-result', output: 'done', isError: false }
const imageRefBlock: NativeChatBlock = { type: 'image-ref', path: '/tmp/a.png', alt: 'a' }

describe('native chat block guards', () => {
  it('isTextBlock narrows only text blocks', () => {
    expect(isTextBlock(textBlock)).toBe(true)
    expect(isTextBlock(toolCallBlock)).toBe(false)
    expect(isTextBlock(toolResultBlock)).toBe(false)
    expect(isTextBlock(imageRefBlock)).toBe(false)
  })

  it('isToolCallBlock narrows only tool-call blocks', () => {
    expect(isToolCallBlock(toolCallBlock)).toBe(true)
    expect(isToolCallBlock(textBlock)).toBe(false)
  })

  it('isToolResultBlock narrows only tool-result blocks', () => {
    expect(isToolResultBlock(toolResultBlock)).toBe(true)
    expect(isToolResultBlock(toolCallBlock)).toBe(false)
  })

  it('isImageRefBlock narrows only image-ref blocks', () => {
    expect(isImageRefBlock(imageRefBlock)).toBe(true)
    expect(isImageRefBlock(textBlock)).toBe(false)
  })
})

describe('source priority', () => {
  it('ranks transcript > hook > scrape', () => {
    expect(NATIVE_CHAT_SOURCE_PRIORITY.transcript).toBeGreaterThan(NATIVE_CHAT_SOURCE_PRIORITY.hook)
    expect(NATIVE_CHAT_SOURCE_PRIORITY.hook).toBeGreaterThan(NATIVE_CHAT_SOURCE_PRIORITY.scrape)
  })
})

describe('isAgentNoticeMessage', () => {
  const base: Omit<NativeChatMessage, 'role' | 'noticeKind'> = {
    id: 'm1',
    blocks: [{ type: 'text', text: 'hi' }],
    timestamp: null,
    source: 'transcript'
  }

  it('is true only for a system message carrying a noticeKind', () => {
    expect(isAgentNoticeMessage({ ...base, role: 'system', noticeKind: 'generic' })).toBe(true)
    expect(isAgentNoticeMessage({ ...base, role: 'system', noticeKind: 'login-required' })).toBe(
      true
    )
  })

  it('is false for an ordinary system aside with no noticeKind', () => {
    expect(isAgentNoticeMessage({ ...base, role: 'system' })).toBe(false)
  })

  it('is false for a non-system message even if noticeKind were set', () => {
    expect(isAgentNoticeMessage({ ...base, role: 'assistant', noticeKind: 'generic' })).toBe(false)
  })
})
