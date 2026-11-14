import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH,
  normalizeAgentSessionConversationName
} from './agent-session-conversation-name'

describe('normalizeAgentSessionConversationName hostile text', () => {
  it('strips controls and lone surrogates', () => {
    expect(normalizeAgentSessionConversationName('Fix\u0007the probe')).toBe('Fix the probe')
    expect(normalizeAgentSessionConversationName('Fix\uD800 the\uDC00 probe')).toBe('Fix the probe')
    expect(normalizeAgentSessionConversationName('\u202E\u200B ')).toBeNull()
  })

  it('never truncates through a surrogate pair', () => {
    const name = `${'a'.repeat(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 1)}\u{1F600}tail`

    const normalized = normalizeAgentSessionConversationName(name)

    // A raw slice strands the emoji's high surrogate, rendered as U+FFFD.
    expect(normalized).toBe('a'.repeat(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 1))
    expect(normalized).not.toContain('\uFFFD')
  })
})

describe('normalizeAgentSessionConversationName joiners', () => {
  const ZWJ = '\u200D'

  it('drops a tag-character payload hidden after a real title', () => {
    // Invisible tag characters encode readable ASCII; this payload reached real Codex history through thread/name/set.
    const hidden = Array.from('ransom', (c) =>
      String.fromCodePoint(0xe0000 + c.charCodeAt(0))
    ).join('')

    const normalized = normalizeAgentSessionConversationName(`Fix login bug${hidden}`)

    expect(normalized).toBe('Fix login bug')
    expect(Array.from(normalized ?? '', (c) => c.codePointAt(0) ?? 0).every((c) => c < 0x7f)).toBe(
      true
    )
  })

  it('never ends a truncated name on a dangling joiner', () => {
    const name = `${'A'.repeat(197)}\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`

    const normalized = normalizeAgentSessionConversationName(name)

    // The cut lands mid-sequence; the joiner it strands attaches to nothing.
    expect(normalized?.endsWith(ZWJ)).toBe(false)
    expect(normalized).toBe(`${'A'.repeat(197)}\u{1F468}`)
    expect(normalized).not.toContain('\uFFFD')
  })
})
