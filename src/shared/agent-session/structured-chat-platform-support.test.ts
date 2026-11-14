import { describe, expect, it } from 'vitest'
import { structuredChatUnavailableOnPlatform } from './structured-chat-platform-support'

describe('structuredChatUnavailableOnPlatform', () => {
  it('returns false for antigravity across all platforms including win32', () => {
    expect(structuredChatUnavailableOnPlatform('antigravity', 'win32')).toBe(false)
    expect(structuredChatUnavailableOnPlatform('antigravity', 'linux')).toBe(false)
    expect(structuredChatUnavailableOnPlatform('antigravity', 'darwin')).toBe(false)
    expect(structuredChatUnavailableOnPlatform('antigravity', null)).toBe(false)
    expect(structuredChatUnavailableOnPlatform('antigravity', undefined)).toBe(false)
  })
})
