import { describe, expect, it } from 'vitest'
import {
  getAgentImageHandling,
  isNativeChatPastedImagePath,
  resolveImagePaste
} from './native-chat-image-paste'

describe('image paste agent map', () => {
  it('known image-capable agent attaches the temp file path', () => {
    expect(getAgentImageHandling('claude')).toBe('attachment')
    const result = resolveImagePaste('claude', '/tmp/orca-img-123.png')
    expect(result).toEqual({ kind: 'attach', path: '/tmp/orca-img-123.png' })
  })

  it('codex also attaches image paths', () => {
    expect(resolveImagePaste('codex', '/tmp/x.png')).toEqual({
      kind: 'attach',
      path: '/tmp/x.png'
    })
  })

  it('grok attaches image paths like other vision-capable TUIs', () => {
    expect(getAgentImageHandling('grok')).toBe('attachment')
    expect(resolveImagePaste('grok', '/tmp/orca-paste-1.png')).toEqual({
      kind: 'attach',
      path: '/tmp/orca-paste-1.png'
    })
  })

  it('unknown/custom agent is unsupported', () => {
    expect(getAgentImageHandling('some-custom-agent')).toBe('unsupported')
    expect(resolveImagePaste('some-custom-agent', '/tmp/x.png')).toEqual({
      kind: 'unsupported',
      agent: 'some-custom-agent'
    })
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
