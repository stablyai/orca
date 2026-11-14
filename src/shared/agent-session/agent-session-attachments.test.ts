import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES,
  sanitizeAgentSessionAttachmentName
} from './agent-session-attachments'

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength

describe('sanitizeAgentSessionAttachmentName', () => {
  it('caps a long name in UTF-8 bytes on whole characters, keeping its extension', () => {
    const name = sanitizeAgentSessionAttachmentName(`${'图'.repeat(120)}.pdf`)
    expect(bytes(name)).toBeLessThanOrEqual(AGENT_SESSION_ATTACHMENT_NAME_MAX_BYTES)
    expect(name).toBe(`${'图'.repeat(65)}.pdf`)
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
})
