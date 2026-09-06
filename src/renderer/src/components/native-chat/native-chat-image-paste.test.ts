import { describe, expect, it } from 'vitest'
import { getAgentImageHandling, isNativeChatPastedImagePath } from './native-chat-image-paste'

describe('image paste agent map', () => {
  it('vision-capable TUIs take image attachments', () => {
    expect(getAgentImageHandling('claude')).toBe('attachment')
    expect(getAgentImageHandling('codex')).toBe('attachment')
    expect(getAgentImageHandling('grok')).toBe('attachment')
  })

  it('unknown/custom agent is unsupported', () => {
    expect(getAgentImageHandling('some-custom-agent')).toBe('unsupported')
  })
})

describe('isNativeChatPastedImagePath', () => {
  it('detects clipboard-paste temp files (so the chip shows a friendly label)', () => {
    expect(
      isNativeChatPastedImagePath(
        '/var/folders/x/orca-paste-1782775228480-c9a3c86b-1234-5678-9abc-def012345678.png'
      )
    ).toBe(true)
    // Windows-style separators resolve to the same basename.
    expect(isNativeChatPastedImagePath('C:\\Temp\\orca-paste-1-2.png')).toBe(true)
  })

  it('leaves picked/dropped files showing their real name', () => {
    expect(isNativeChatPastedImagePath('/Users/me/Pictures/hero-image-2.png')).toBe(false)
    expect(isNativeChatPastedImagePath('/tmp/screenshot.png')).toBe(false)
  })
})
