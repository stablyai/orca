import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  agentSubagentsEqual,
  parseAgentStatusPayload,
  normalizeAgentStatusPayload,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_STATES,
  AGENT_TYPE_MAX_LENGTH
} from './agent-status-types'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  // Why: dispatch preambles bury the task body after multi-KB CLI text; naive head-truncation would keep only boilerplate.
  it('compacts Orca dispatch preambles so the task body survives 200-char truncation', () => {
    const longCliNoise = Array.from(
      { length: 50 },
      (_, i) => `orca orchestration send --to term_parent --type heartbeat --phase step-${i}`
    ).join('\n')
    const result = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task_compact_1

=== CLI COMMANDS ===
${longCliNoise}

=== TASK ===
Fix dispatch fallback preview for normalized status prompts`
      })
    )
    expect(result).not.toBeNull()
    expect(result!.prompt.length).toBeLessThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH)
    expect(result!.prompt.includes('\n')).toBe(false)
    expect(result!.prompt.startsWith('You are working inside Orca, a multi-agent IDE.')).toBe(true)
    expect(result!.prompt).toContain('Your task ID is: task_compact_1')
    expect(result!.prompt).toContain('=== TASK ===')
    expect(result!.prompt).toContain('Fix dispatch fallback preview')
    expect(result!.prompt).not.toContain('CLI COMMANDS')
    expect(result!.prompt).not.toContain('heartbeat')
  })

  it('ignores task-marker text inside base-drift commit subjects', () => {
    const result = normalizeAgentStatusPayload({
      state: 'working',
      // Why: CRLF covers Windows hook payloads; commit text must not impersonate the task separator.
      prompt: [
        'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
        'Your task ID is: task_drift_marker',
        '',
        '--- BASE DRIFT ---',
        '  - docs: explain === TASK === marker parsing',
        '---',
        '',
        '=== TASK ===',
        'Fix the actual dispatch fallback preview'
      ].join('\r\n')
    })

    expect(result!.prompt).toContain('=== TASK === Fix the actual dispatch fallback preview')
    expect(result!.prompt).not.toContain('marker parsing')
  })

  it('keeps dispatch detection bounded for oversized whitespace prompts', () => {
    const trimStartSpy = vi.spyOn(String.prototype, 'trimStart')
    const prompt = ' '.repeat(1_000_000)

    expect(normalizeAgentStatusPayload({ state: 'working', prompt })!.prompt).toBe('')
    expect(
      trimStartSpy.mock.contexts.some((context) => String(context).length === prompt.length)
    ).toBe(false)
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
    // Why: agentType is single-line; a newline must not leak into UI rendering or equality checks.
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

  it('parses interactivePrompt without single-line collapse', () => {
    const interactivePrompt = JSON.stringify({
      questions: [{ question: 'Pick one', options: ['a', 'b'] }]
    })
    const result = parseAgentStatusPayload(JSON.stringify({ state: 'waiting', interactivePrompt }))
    // Why: interactivePrompt is raw JSON the client parses back, so content must survive untouched (unlike toolInput).
    expect(result!.interactivePrompt).toBe(interactivePrompt)
  })

  it('preserves newlines inside interactivePrompt JSON', () => {
    const interactivePrompt = '{\n  "questions": []\n}'
    const result = parseAgentStatusPayload(JSON.stringify({ state: 'waiting', interactivePrompt }))
    expect(result!.interactivePrompt).toBe(interactivePrompt)
  })

  it('caps interactivePrompt at its generous max length (not the toolInput cap)', () => {
    const long = 'x'.repeat(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH + 500)
    const result = parseAgentStatusPayload(
      JSON.stringify({ state: 'waiting', interactivePrompt: long })
    )
    expect(result!.interactivePrompt).toHaveLength(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
    expect(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH).toBe(16000)
  })

  it('leaves interactivePrompt undefined when absent or non-string', () => {
    expect(parseAgentStatusPayload('{"state":"working"}')!.interactivePrompt).toBeUndefined()
    expect(
      parseAgentStatusPayload('{"state":"working","interactivePrompt":42}')!.interactivePrompt
    ).toBeUndefined()
    expect(
      parseAgentStatusPayload('{"state":"working","interactivePrompt":""}')!.interactivePrompt
    ).toBeUndefined()
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

  it('normalizes large single-line preview fields without full-string replacement passes', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const prompt = `Summary\r\nDetails ${'x'.repeat(20_000)}`
    const toolInput = `src/index.ts${String.fromCharCode(0x2028)}${'line\n'.repeat(10_000)}`

    const result = normalizeAgentStatusPayload({
      state: 'working',
      prompt,
      toolInput
    })

    expect(result!.prompt.startsWith('Summary Details ')).toBe(true)
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
    expect(result!.toolInput?.startsWith('src/index.ts ')).toBe(true)
    expect(result!.toolInput!.length).toBeLessThanOrEqual(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('bounds scanning when oversized single-line previews are mostly line breaks', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const prompt = `Summary${'\n'.repeat(10_000)}Details`

    const result = normalizeAgentStatusPayload({ state: 'working', prompt })

    expect(result!.prompt).toBe('Summary')
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('preserves paragraph breaks in lastAssistantMessage', () => {
    // Why: assistant message renders with whitespace-pre-wrap, so paragraph breaks must survive.
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

  it('normalizes large assistant messages without full-string replacement passes', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const lastAssistantMessage = `Summary\r\n${'\r\n'.repeat(10_000)}Details ${'x'.repeat(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )}`

    const result = parseAgentStatusPayload(JSON.stringify({ state: 'done', lastAssistantMessage }))

    expect(result!.lastAssistantMessage?.startsWith('Summary\n\nDetails ')).toBe(true)
    expect(result!.lastAssistantMessage!.length).toBeLessThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )
    const usedMultilineReplace = replaceSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        ['\\r\\n', '\\r', '[\\u2028\\u2029]', '\\n{3,}'].includes(pattern.source)
    )
    expect(usedMultilineReplace).toBe(false)
  })

  it('folds Unicode line/paragraph separators into \\n and caps blank-line runs in lastAssistantMessage', () => {
    // Why: U+2028/U+2029 render as line breaks under whitespace-pre-wrap; fold to \n so the blank-line cap applies.
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
    // Why: parser uses `=== true`, so truthy string/number sentinels don't count.
    expect(
      parseAgentStatusPayload('{"state":"done","interrupted":"true"}')!.interrupted
    ).toBeUndefined()
    expect(parseAgentStatusPayload('{"state":"done","interrupted":1}')!.interrupted).toBeUndefined()
    expect(
      parseAgentStatusPayload('{"state":"done","interrupted":"yes"}')!.interrupted
    ).toBeUndefined()
  })

  it('never leaves a lone high surrogate when truncating mid surrogate-pair', () => {
    // Why: prepend one code unit so truncation lands ON a high surrogate, else the test passes without the guard.
    const prompt = `x${'😀'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH)}`
    const result = parseAgentStatusPayload(JSON.stringify({ state: 'working', prompt }))
    expect(result!.prompt.length).toBeLessThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH)
    // Why: guard drops at most ONE trailing high surrogate, so output must still reach max - 1.
    expect(result!.prompt.length).toBeGreaterThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH - 1)
    const len = result!.prompt.length
    const last = result!.prompt.charCodeAt(len - 1)
    const secondLast = len >= 2 ? result!.prompt.charCodeAt(len - 2) : 0
    const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff
    expect(isLoneHighSurrogate).toBe(false)
    // Why: a trailing low surrogate must follow a high surrogate, else it's also malformed UTF-16.
    if (last >= 0xdc00 && last <= 0xdfff) {
      expect(secondLast >= 0xd800 && secondLast <= 0xdbff).toBe(true)
    }
  })

  it('never leaves a lone high surrogate in lastAssistantMessage truncation', () => {
    // Why: cover the multiline surrogate-pair guard too, so a refactor can't drop it on one side.
    const surrogatePairs = Math.floor(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH / 2) + 1
    // Why: prepend one code unit so truncation lands ON a high surrogate, else the test passes without the guard.
    const message = `x${'😀'.repeat(surrogatePairs)}`
    const result = parseAgentStatusPayload(
      JSON.stringify({ state: 'done', lastAssistantMessage: message })
    )
    expect(result!.lastAssistantMessage!.length).toBeLessThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )
    // Why: guard drops at most ONE trailing high surrogate, so output must still reach max - 1.
    expect(result!.lastAssistantMessage!.length).toBeGreaterThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH - 1
    )
    const len = result!.lastAssistantMessage!.length
    const last = result!.lastAssistantMessage!.charCodeAt(len - 1)
    const secondLast = len >= 2 ? result!.lastAssistantMessage!.charCodeAt(len - 2) : 0
    const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff
    expect(isLoneHighSurrogate).toBe(false)
    // Why: a trailing low surrogate must follow a high surrogate, else it's also malformed UTF-16.
    if (last >= 0xdc00 && last <= 0xdfff) {
      expect(secondLast >= 0xd800 && secondLast <= 0xdbff).toBe(true)
    }
  })

  it('normalizes the subagents field, dropping invalid entries and bounding count', () => {
    const result = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        subagents: [
          { id: 'a1', state: 'working', startedAt: 100, agentType: 'general-purpose' },
          { id: 'r1', state: 'idle', startedAt: 'nope', description: 'line\none' },
          { id: '', state: 'working', startedAt: 1 },
          { id: 'bad-state', state: 'running', startedAt: 1 },
          'garbage',
          ...Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS + 5 }, (_, i) => ({
            id: `extra-${i}`,
            state: 'idle',
            startedAt: i
          }))
        ]
      })
    )
    expect(result?.subagents?.length).toBe(AGENT_STATUS_MAX_SUBAGENTS)
    expect(result?.subagents?.[0]).toEqual({
      id: 'a1',
      state: 'working',
      startedAt: 100,
      agentType: 'general-purpose',
      description: undefined
    })
    // Why: non-finite startedAt coerces to 0; descriptions fold to one line.
    expect(result?.subagents?.[1]).toMatchObject({
      id: 'r1',
      startedAt: 0,
      description: 'line one'
    })
  })

  it('omits subagents when absent or empty', () => {
    expect(parseAgentStatusPayload('{"state":"done"}')?.subagents).toBeUndefined()
    expect(parseAgentStatusPayload('{"state":"done","subagents":[]}')?.subagents).toBeUndefined()
  })
})

describe('agentSubagentsEqual', () => {
  const snapshot = { id: 'a1', state: 'working' as const, startedAt: 1 }

  it('compares structurally and treats undefined/empty as distinct from populated', () => {
    expect(agentSubagentsEqual(undefined, undefined)).toBe(true)
    expect(agentSubagentsEqual([snapshot], [{ ...snapshot }])).toBe(true)
    expect(agentSubagentsEqual([snapshot], [{ ...snapshot, state: 'idle' }])).toBe(false)
    expect(agentSubagentsEqual([snapshot], undefined)).toBe(false)
    expect(agentSubagentsEqual(undefined, [snapshot])).toBe(false)
    expect(agentSubagentsEqual([snapshot], [snapshot, { ...snapshot, id: 'b' }])).toBe(false)
  })
})
