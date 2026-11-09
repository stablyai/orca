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
  // Preserve U+200C/U+200D: stripping them breaks family emoji and Persian/Hindi orthography in user-language names.
  const ZWJ = '\u200D'
  const ZWNJ = '\u200C'

  it.each([
    ['family emoji', `Fix \u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467} layout`],
    ['flag emoji', `Ship \u{1F3F3}\uFE0F${ZWJ}\u{1F308} theme`],
    ['profession emoji', `Add \u{1F469}${ZWJ}\u{1F4BB} avatar`],
    ['Persian ZWNJ', `می${ZWNJ}خواهم تست`],
    ['Hindi ZWNJ conjunct', `क्${ZWNJ}ष ठीक`]
  ])('keeps the joiners in a %s name', (_label, name) => {
    expect(normalizeAgentSessionConversationName(name)).toBe(name)
  })

  // These Cf runs escaped the old enumeration and produced nonempty labels that rendered invisibly.
  it.each([
    ['invisible maths operators', '\u2061\u2062\u2063\u2064'],
    ['tag characters', '\u{E0020}\u{E0041}\u{E007F}'],
    ['a Mongolian vowel separator', '\u180E'],
    ['interlinear annotation marks', '\uFFF9\uFFFA\uFFFB'],
    ['deprecated format characters', '\u206A\u206B\u206C\u206D\u206E\u206F'],
    ['Arabic number signs', '\u0600\u0601\u06DD'],
    ['the joiners themselves', `${ZWNJ}${ZWJ}`],
    ['a bidi and zero-width mix', '\u202E\u200B\u2060'],
    // Surviving joiners split collapsed runs; the blank-label guard must also consume the resulting spaces.
    ['joiners split by a tab', `${ZWJ}\t${ZWJ}`],
    ['joiners split by a newline', `${ZWJ}\n${ZWJ}`],
    ['joiners split by a byte order mark', `${ZWJ}\uFEFF${ZWJ}`],
    ['joiners split by zero-width spaces', `\u200B${ZWJ}\u200B${ZWJ}`],
    ['joiners split by literal spaces', ` ${ZWJ} ${ZWJ} `],
    ['joiners split by a bidi override', `\u202E${ZWJ}\u202E${ZWJ}`],
    ['mixed joiners split by a tab', `${ZWJ}\t${ZWNJ}`],
    ['joiners wrapped in tag characters', `\u{E0020}${ZWJ}\u{E0041}${ZWJ}\u{E007F}`]
  ])('rejects a name that is only %s', (_label, name) => {
    expect(normalizeAgentSessionConversationName(name)).toBeNull()
  })

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
