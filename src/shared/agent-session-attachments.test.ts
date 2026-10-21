import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES,
  sanitizeAgentSessionAttachmentName
} from './agent-session-attachments'

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength

describe('sanitizeAgentSessionAttachmentName', () => {
  it('keeps only the last path segment', () => {
    expect(sanitizeAgentSessionAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeAgentSessionAttachmentName('C:\\Users\\me\\shot.png')).toBe('shot.png')
  })

  it('caps a long name in UTF-8 bytes on whole characters, keeping its extension', () => {
    const name = sanitizeAgentSessionAttachmentName(`${'图'.repeat(120)}.pdf`)
    expect(bytes(name)).toBeLessThanOrEqual(AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(name).not.toContain('\uFFFD')
  })

  it('never ends in a dot or space, even where the cut lands on one', () => {
    // No short extension to keep, so the cut falls inside the name, right after a dot.
    const long = `${'a'.repeat(AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES - 1)}.${'b'.repeat(30)}`
    const name = sanitizeAgentSessionAttachmentName(long)
    expect(name).toBe('a'.repeat(AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES - 1))
    expect(sanitizeAgentSessionAttachmentName('notes. .')).toBe('notes')
  })

  it('renames what Windows reserves for devices', () => {
    expect(sanitizeAgentSessionAttachmentName('CON')).toBe('_CON')
    expect(sanitizeAgentSessionAttachmentName('nul.tar.gz')).toBe('_nul.tar.gz')
    expect(sanitizeAgentSessionAttachmentName('console.log')).toBe('console.log')
  })
})
