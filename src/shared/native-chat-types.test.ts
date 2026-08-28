import { describe, it, expect } from 'vitest'
import {
  isTextBlock,
  isToolCallBlock,
  isToolResultBlock,
  isImageRefBlock,
  isAgentNoticeMessage,
  isInterruptedStatusMessage,
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
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

describe('agent notice vs interrupt status', () => {
  const base = {
    id: 'row-1',
    blocks: [{ type: 'text' as const, text: 'Please run /login' }],
    timestamp: null,
    source: 'transcript' as const
  }

  it('treats structured notice metadata as a bannerable system notice', () => {
    const message: NativeChatMessage = {
      ...base,
      role: 'system',
      notice: { level: 'warning' }
    }
    expect(isAgentNoticeMessage(message)).toBe(true)
    expect(isInterruptedStatusMessage(message)).toBe(false)
  })

  it('does not treat interrupt status as an agent notice', () => {
    const message: NativeChatMessage = {
      ...base,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }]
    }
    expect(isInterruptedStatusMessage(message)).toBe(true)
    expect(isAgentNoticeMessage(message)).toBe(false)
  })

  it('treats notice metadata as authoritative when copy matches interrupt status', () => {
    const message: NativeChatMessage = {
      ...base,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      notice: { level: 'warning' }
    }
    expect(isInterruptedStatusMessage(message)).toBe(false)
    expect(isAgentNoticeMessage(message)).toBe(true)
  })
})
