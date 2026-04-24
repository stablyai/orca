import { describe, it, expect } from 'vitest'
import {
  parseAgentStatusPayload,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_STATES,
  AGENT_TYPE_MAX_LENGTH
} from './agent-status-types'

describe('parseAgentStatusPayload', () => {
  it('parses a valid working payload', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","prompt":"Fix the flaky assertion","agentType":"codex"}'
    )
    expect(result).toEqual({
      state: 'working',
      prompt: 'Fix the flaky assertion',
      agentType: 'codex'
    })
  })

  it('parses all AGENT_STATUS_STATES', () => {
    for (const state of AGENT_STATUS_STATES) {
      const result = parseAgentStatusPayload(`{"state":"${state}"}`)
      expect(result).not.toBeNull()
      expect(result!.state).toBe(state)
    }
  })

  it('returns null for invalid state', () => {
    expect(parseAgentStatusPayload('{"state":"running"}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":"idle"}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":""}')).toBeNull()
  })

  it('returns null when state is a non-string type', () => {
    expect(parseAgentStatusPayload('{"state":123}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":true}')).toBeNull()
    expect(parseAgentStatusPayload('{"state":null}')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseAgentStatusPayload('not json')).toBeNull()
    expect(parseAgentStatusPayload('{broken')).toBeNull()
    expect(parseAgentStatusPayload('')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(parseAgentStatusPayload('"just a string"')).toBeNull()
    expect(parseAgentStatusPayload('42')).toBeNull()
    expect(parseAgentStatusPayload('null')).toBeNull()
    expect(parseAgentStatusPayload('[]')).toBeNull()
  })

  it('normalizes multiline prompt to single line', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","prompt":"line one\\nline two\\nline three"}'
    )
    expect(result!.prompt).toBe('line one line two line three')
  })

  it('normalizes Windows-style line endings (\\r\\n) to single line', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","prompt":"line one\\r\\nline two\\r\\nline three"}'
    )
    expect(result!.prompt).toBe('line one line two line three')
  })

  it('trims whitespace from the prompt field', () => {
    const result = parseAgentStatusPayload('{"state":"working","prompt":"  padded  "}')
    expect(result!.prompt).toBe('padded')
  })

  it('truncates the prompt beyond max length', () => {
    const longString = 'x'.repeat(300)
    const result = parseAgentStatusPayload(`{"state":"working","prompt":"${longString}"}`)
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
  })

  it('defaults missing prompt to empty string', () => {
    const result = parseAgentStatusPayload('{"state":"done"}')
    expect(result!.prompt).toBe('')
  })

  it('handles non-string prompt gracefully', () => {
    const result = parseAgentStatusPayload('{"state":"working","prompt":42}')
    expect(result!.prompt).toBe('')
  })

  it('accepts custom non-empty agentType values', () => {
    const result = parseAgentStatusPayload('{"state":"working","agentType":"cursor"}')
    expect(result).toEqual({
      state: 'working',
      prompt: '',
      agentType: 'cursor'
    })
  })

  it('truncates agentType beyond AGENT_TYPE_MAX_LENGTH', () => {
    const longAgentType = 'a'.repeat(AGENT_TYPE_MAX_LENGTH + 20)
    const result = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', agentType: longAgentType })
    )
    expect(result!.agentType).toHaveLength(AGENT_TYPE_MAX_LENGTH)
  })

  it('treats whitespace-only agentType as undefined', () => {
    const result = parseAgentStatusPayload('{"state":"working","agentType":"   "}')
    expect(result!.agentType).toBeUndefined()
  })

  it('collapses newlines in agentType (single-line field)', () => {
    // Why: pins the regression the parser comment on agent-status-types.ts calls
    // out — a payload with agentType: "claude\nrogue" must not leak the newline
    // into UI rendering or equality checks.
    const result = parseAgentStatusPayload('{"state":"working","agentType":"claude\\nrogue"}')
    expect(result!.agentType).toBe('claude rogue')
  })

  it('parses toolName, toolInput, and lastAssistantMessage', () => {
    const result = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        toolName: 'Edit',
        toolInput: '/path/to/file.ts',
        lastAssistantMessage: 'Here is the edit I made.'
      })
    )
    expect(result).toEqual({
      state: 'working',
      prompt: '',
      agentType: undefined,
      toolName: 'Edit',
      toolInput: '/path/to/file.ts',
      lastAssistantMessage: 'Here is the edit I made.'
    })
  })

  it('truncates each optional field to its own cap', () => {
    const longName = 'n'.repeat(AGENT_STATUS_TOOL_NAME_MAX_LENGTH + 50)
    const longInput = 'i'.repeat(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH + 50)
    const longMessage = 'm'.repeat(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH + 500)
    const result = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        toolName: longName,
        toolInput: longInput,
        lastAssistantMessage: longMessage
      })
    )
    expect(result!.toolName).toHaveLength(AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
    expect(result!.toolInput).toHaveLength(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
    expect(result!.lastAssistantMessage).toHaveLength(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH)
  })

  it('leaves omitted optional fields undefined (not empty string)', () => {
    const result = parseAgentStatusPayload('{"state":"working"}')
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('treats non-string optional fields as undefined', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","toolName":42,"toolInput":null,"lastAssistantMessage":[]}'
    )
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('treats empty-string optional fields as undefined', () => {
    const result = parseAgentStatusPayload(
      '{"state":"working","toolName":"   ","toolInput":"","lastAssistantMessage":"   "}'
    )
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('collapses newlines in toolInput (single-line preview field)', () => {
    const result = parseAgentStatusPayload('{"state":"working","toolInput":"line one\\nline two"}')
    expect(result!.toolInput).toBe('line one line two')
  })

  it('preserves paragraph breaks in lastAssistantMessage', () => {
    // Why: the assistant message is rendered with `whitespace-pre-wrap` in the
    // dashboard row so the user sees the same paragraph structure the agent
    // produced. Collapsing newlines would destroy that structure.
    const result = parseAgentStatusPayload(
      '{"state":"done","lastAssistantMessage":"Summary line.\\n\\nDetails paragraph."}'
    )
    expect(result!.lastAssistantMessage).toBe('Summary line.\n\nDetails paragraph.')
  })

  it('normalizes \\r\\n to \\n and caps blank-line runs at one in lastAssistantMessage', () => {
    const result = parseAgentStatusPayload(
      '{"state":"done","lastAssistantMessage":"a\\r\\nb\\n\\n\\n\\nc"}'
    )
    expect(result!.lastAssistantMessage).toBe('a\nb\n\nc')
  })

  it('folds Unicode line/paragraph separators into \\n and caps blank-line runs in lastAssistantMessage', () => {
    // Why: U+2028 and U+2029 render as real line breaks under
    // `whitespace-pre-wrap`. Without folding them to `\n`, a payload with
    // many separators would bypass the `\n{3,}` → `\n\n` safeguard and let
    // an agent emit arbitrarily many paragraph breaks. Pin that the
    // multiline normalizer treats these code points the same way the
    // single-line normalizer does (strip/convert), so the blank-line cap
    // applies.
    const resultLineSep = parseAgentStatusPayload(
      '{"state":"done","lastAssistantMessage":"a\u2028\u2028\u2028\u2028b"}'
    )
    expect(resultLineSep!.lastAssistantMessage).toBe('a\n\nb')

    const resultParaSep = parseAgentStatusPayload(
      '{"state":"done","lastAssistantMessage":"a\u2029\u2029\u2029\u2029b"}'
    )
    expect(resultParaSep!.lastAssistantMessage).toBe('a\n\nb')

    const resultMixed = parseAgentStatusPayload(
      '{"state":"done","lastAssistantMessage":"a\u2028\u2029\\n\u2028\u2029b"}'
    )
    expect(resultMixed!.lastAssistantMessage).toBe('a\n\nb')
  })

  it('still respects the base prompt cap independent of the new fields', () => {
    const prompt = 'p'.repeat(300)
    const result = parseAgentStatusPayload(
      JSON.stringify({ state: 'working', prompt, toolInput: 'x'.repeat(5) })
    )
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
    expect(result!.toolInput).toBe('xxxxx')
  })

  it('preserves interrupted=true when state is done', () => {
    const result = parseAgentStatusPayload('{"state":"done","interrupted":true}')
    expect(result!.interrupted).toBe(true)
  })

  it('clears interrupted on non-done states (stale-signal suppression)', () => {
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      const result = parseAgentStatusPayload(`{"state":"${state}","interrupted":true}`)
      expect(result!.interrupted).toBeUndefined()
    }
  })

  it('requires strict boolean true for interrupted (rejects truthy non-boolean)', () => {
    // Why: the parser uses `=== true` to guard against agents that surface a
    // string or numeric truthy sentinel; only an explicit boolean counts.
    expect(
      parseAgentStatusPayload('{"state":"done","interrupted":"true"}')!.interrupted
    ).toBeUndefined()
    expect(parseAgentStatusPayload('{"state":"done","interrupted":1}')!.interrupted).toBeUndefined()
    expect(
      parseAgentStatusPayload('{"state":"done","interrupted":"yes"}')!.interrupted
    ).toBeUndefined()
  })

  it('never leaves a lone high surrogate when truncating mid surrogate-pair', () => {
    // Why: prepend a single-code-unit character so truncation at the (even)
    // AGENT_STATUS_MAX_FIELD_LENGTH cap lands ON a high surrogate rather than
    // between complete pairs. Without this prefix the test would pass even if
    // the surrogate guard were removed, because the last code unit would
    // always be a low surrogate.
    const prompt = `x${'😀'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH)}`
    const result = parseAgentStatusPayload(JSON.stringify({ state: 'working', prompt }))
    expect(result!.prompt.length).toBeLessThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH)
    // Why: pins the guard as load-bearing — a future change that over-trims
    // (e.g., drops more than one trailing code unit by accident) would leave
    // the non-malformed assertions happy but silently shrink the output.
    // The surrogate-pair guard may drop at most ONE trailing high surrogate,
    // so the result must still reach `max - 1`.
    expect(result!.prompt.length).toBeGreaterThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH - 1)
    const len = result!.prompt.length
    const last = result!.prompt.charCodeAt(len - 1)
    const secondLast = len >= 2 ? result!.prompt.charCodeAt(len - 2) : 0
    const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff
    expect(isLoneHighSurrogate).toBe(false)
    // Why: if the last char is a low surrogate, its preceding char must be a
    // high surrogate — otherwise we'd have a dangling low surrogate, which is
    // also malformed UTF-16. Pin both directions so the guard is actually load-bearing.
    if (last >= 0xdc00 && last <= 0xdfff) {
      expect(secondLast >= 0xd800 && secondLast <= 0xdbff).toBe(true)
    }
  })

  it('never leaves a lone high surrogate in lastAssistantMessage truncation', () => {
    // Why: the multiline normalizer has the same surrogate-pair guard as the
    // single-line path; cover both so a refactor can't drop the protection
    // on one side. Emoji count chosen to land truncation inside a pair.
    const surrogatePairs = Math.floor(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH / 2) + 1
    // Why: prepend a single-code-unit character so truncation at the (even)
    // cap lands ON a high surrogate rather than between complete pairs. Without
    // this prefix the test would pass even if the surrogate guard were removed,
    // because the last code unit would always be a low surrogate.
    const message = `x${'😀'.repeat(surrogatePairs)}`
    const result = parseAgentStatusPayload(
      JSON.stringify({ state: 'done', lastAssistantMessage: message })
    )
    expect(result!.lastAssistantMessage!.length).toBeLessThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )
    // Why: pins the guard as load-bearing — a future change that over-trims
    // (e.g., drops more than one trailing code unit by accident) would leave
    // the non-malformed assertions happy but silently shrink the output.
    // The surrogate-pair guard may drop at most ONE trailing high surrogate,
    // so the result must still reach `max - 1`.
    expect(result!.lastAssistantMessage!.length).toBeGreaterThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH - 1
    )
    const len = result!.lastAssistantMessage!.length
    const last = result!.lastAssistantMessage!.charCodeAt(len - 1)
    const secondLast = len >= 2 ? result!.lastAssistantMessage!.charCodeAt(len - 2) : 0
    const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff
    expect(isLoneHighSurrogate).toBe(false)
    // Why: if the last char is a low surrogate, its preceding char must be a
    // high surrogate — otherwise we'd have a dangling low surrogate, which is
    // also malformed UTF-16. Pin both directions so the guard is actually load-bearing.
    if (last >= 0xdc00 && last <= 0xdfff) {
      expect(secondLast >= 0xd800 && secondLast <= 0xdbff).toBe(true)
    }
  })
})
