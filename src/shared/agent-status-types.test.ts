import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  isFreshNonDoneAgentStatus,
  parseAgentStatusPayload,
  normalizeAgentStatusPayload,
  AGENT_STATUS_JSON_STRUCTURE_LIMITS,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
} from './agent-status-types'
import type { AgentType } from './agent-status-types'
import {
  ORCA_DISPATCH_PROMPT_LEAD_LINE,
  ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX
} from './orca-dispatch-status-prompt'
import { parseAskFromStatus } from './native-chat/input/native-chat-ask'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isFreshNonDoneAgentStatus', () => {
  it('never treats a restored-unconfirmed entry as fresh, regardless of age', () => {
    expect(
      isFreshNonDoneAgentStatus(
        { state: 'working', updatedAt: 1_999, restoredUnconfirmed: true },
        2_000
      )
    ).toBe(false)
  })
})

describe('parseAgentStatusPayload', () => {
  it('rejects excessive nesting before JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    const depth = AGENT_STATUS_JSON_STRUCTURE_LIMITS.nestingDepth + 1
    try {
      expect(parseAgentStatusPayload(`${'['.repeat(depth)}0${']'.repeat(depth)}`)).toBeNull()
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
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

  it('compacts a Claude hook prompt carrying the typed lead line and paste wrapper', () => {
    const preamble = `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\nYour task ID is: task_lead\n\n=== TASK ===\nAdd greet()`
    const normalize = (prompt: string): string =>
      normalizeAgentStatusPayload({ state: 'working', prompt })!.prompt
    const compact = `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX} Your task ID is: task_lead === TASK === Add greet()`

    // Why: the shape Claude Code's UserPromptSubmit hook reports for a typed lead plus a paste.
    expect(
      normalize(
        `${ORCA_DISPATCH_PROMPT_LEAD_LINE}\n\n<pasted_content id="aac2">\n${preamble}\n</pasted_content id="aac2">\n`
      )
    ).toBe(compact)
    expect(normalize(`\n\n<pasted_content id="965a">\n${preamble}`)).toBe(compact)
    expect(normalize(`<pasted_content ${'x'.repeat(80)}>${preamble}`)).not.toBe(compact)
    expect(normalize(`<pasted_content ${'x'.repeat(30_000)}`)).not.toContain('TASK')
    expect(normalize(`please review: ${preamble}`)).toBe(
      `please review: ${preamble.replace(/\n+/g, ' ')}`
    )
    // Why: the closing paste tag must not become the task body of an empty spec.
    expect(
      normalize(
        `<pasted_content id="1">\n${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\n=== TASK ===\n</pasted_content id="1">`
      )
    ).toBe(ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX)
  })

  it('accepts custom non-empty agentType values', () => {
    const agentType: AgentType = 'some-in-house-agent'
    const result = parseAgentStatusPayload(JSON.stringify({ state: 'working', agentType }))
    expect(result).toEqual({
      state: 'working',
      prompt: '',
      agentType
    })
  })

  it('shortens an oversized question prompt into a card that still parses with every option', () => {
    const interactivePrompt = JSON.stringify({
      questions: [
        {
          question: 'q'.repeat(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH + 4000),
          header: 'Plan',
          options: [{ label: 'Ship it', description: 'd'.repeat(3000) }, { label: 'Wait' }]
        }
      ]
    })
    const result = parseAgentStatusPayload(JSON.stringify({ state: 'waiting', interactivePrompt }))
    expect(result!.interactivePrompt!.length).toBeLessThanOrEqual(
      AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
    )
    const ask = parseAskFromStatus(result!.interactivePrompt, 'ask_user_question')
    expect(ask!.questions[0].question.startsWith('qqq')).toBe(true)
    expect(ask!.questions[0].options.map((option) => option.label)).toEqual(['Ship it', 'Wait'])
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

  it('clears interrupted on non-done states (stale-signal suppression)', () => {
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      const result = parseAgentStatusPayload(`{"state":"${state}","interrupted":true}`)
      expect(result!.interrupted).toBeUndefined()
    }
  })

  it('preserves sessionBoundary=true only on done (stale-signal suppression like interrupted)', () => {
    expect(
      parseAgentStatusPayload('{"state":"done","sessionBoundary":true}')!.sessionBoundary
    ).toBe(true)
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      const result = parseAgentStatusPayload(`{"state":"${state}","sessionBoundary":true}`)
      expect(result!.sessionBoundary).toBeUndefined()
    }
    // Why: parser uses `=== true`, so truthy sentinels don't count.
    expect(
      parseAgentStatusPayload('{"state":"done","sessionBoundary":"true"}')!.sessionBoundary
    ).toBeUndefined()
  })

  it('keeps turnCompletedAt on the gated working row and its all-clear done, nowhere else', () => {
    for (const state of ['working', 'done'] as const) {
      expect(
        parseAgentStatusPayload(`{"state":"${state}","turnCompletedAt":1767225601000}`)!
          .turnCompletedAt
      ).toBe(1767225601000)
    }
    for (const state of ['blocked', 'waiting'] as const) {
      expect(
        parseAgentStatusPayload(`{"state":"${state}","turnCompletedAt":1767225601000}`)!
          .turnCompletedAt
      ).toBeUndefined()
    }
    for (const raw of ['"1767225601000"', 'null', 'true']) {
      expect(
        parseAgentStatusPayload(`{"state":"done","turnCompletedAt":${raw}}`)!.turnCompletedAt
      ).toBeUndefined()
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        normalizeAgentStatusPayload({ state: 'done', turnCompletedAt: value })!.turnCompletedAt
      ).toBeUndefined()
    }
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

  it('normalizes the subagents field, dropping invalid entries and keeping every valid one', () => {
    const result = parseAgentStatusPayload(
      JSON.stringify({
        state: 'working',
        subagents: [
          { id: 'a1', state: 'working', startedAt: 100, agentType: 'general-purpose' },
          { id: 'r1', state: 'idle', startedAt: 'nope', description: 'line\none' },
          { id: 'u1', state: 'unverifiable', startedAt: 200 },
          { id: '', state: 'working', startedAt: 1 },
          { id: 'bad-state', state: 'running', startedAt: 1 },
          'garbage',
          ...Array.from({ length: 37 }, (_, i) => ({
            id: `extra-${i}`,
            state: 'idle',
            startedAt: i
          }))
        ]
      })
    )
    expect(result?.subagents?.length).toBe(40)
    expect(result?.subagents?.[0]).toEqual({
      id: 'a1',
      state: 'working',
      startedAt: 100,
      agentType: 'general-purpose',
      model: undefined,
      description: undefined
    })
    // Why: non-finite startedAt coerces to 0; descriptions fold to one line.
    expect(result?.subagents?.[1]).toMatchObject({
      id: 'r1',
      startedAt: 0,
      description: 'line one'
    })
    expect(result?.subagents?.[2]).toMatchObject({ id: 'u1', state: 'unverifiable' })
  })
})

describe('the main agent field on a status payload', () => {
  it('carries typed quota only on a failed finished root, including an unknown reset', () => {
    const mainAgent = { state: 'done', outcome: 'failure', stateStartedAt: 5, usageLimit: {} }
    expect(normalizeAgentStatusPayload({ state: 'working', mainAgent })?.mainAgent).toEqual(
      mainAgent
    )
    for (const changed of [{ state: 'working' }, { outcome: 'cancellation' }]) {
      expect(
        normalizeAgentStatusPayload({ state: 'working', mainAgent: { ...mainAgent, ...changed } })
          ?.mainAgent?.usageLimit
      ).toBeUndefined()
    }
  })

  it('admits a well-formed main agent with its verdict only while the main agent is done', () => {
    expect(
      parseAgentStatusPayload(
        '{"state":"working","mainAgent":{"state":"done","outcome":"cancellation","stateStartedAt":5}}'
      )?.mainAgent
    ).toEqual({ state: 'done', outcome: 'cancellation', stateStartedAt: 5 })
    // A verdict belongs to a finished turn; one riding on a live main agent state is stale.
    expect(
      parseAgentStatusPayload(
        '{"state":"working","mainAgent":{"state":"working","outcome":"failure","stateStartedAt":5}}'
      )?.mainAgent
    ).toEqual({ state: 'working', stateStartedAt: 5 })
    expect(
      parseAgentStatusPayload(
        '{"state":"done","mainAgent":{"state":"done","outcome":"maybe","stateStartedAt":5}}'
      )?.mainAgent
    ).toEqual({ state: 'done', stateStartedAt: 5 })
  })

  it('admits the host-observed verdicts, and reads an arm it cannot name as no verdict', () => {
    for (const outcome of ['interruption', 'unconfirmed'] as const) {
      expect(
        parseAgentStatusPayload(
          `{"state":"done","mainAgent":{"state":"done","outcome":"${outcome}","stateStartedAt":5}}`
        )?.mainAgent
      ).toEqual({ state: 'done', outcome, stateStartedAt: 5 })
    }
    // A newer host's arm drops the verdict, never the row: the row reads today's done.
    expect(
      parseAgentStatusPayload(
        '{"state":"done","prompt":"keep me","mainAgent":{"state":"done","outcome":"from-a-newer-host","stateStartedAt":5}}'
      )
    ).toMatchObject({ state: 'done', prompt: 'keep me', mainAgent: { state: 'done' } })
  })

  it('drops a malformed main agent but never the row it rides on', () => {
    for (const mainAgent of [
      '"done"',
      '{"state":"running","stateStartedAt":5}',
      '{"state":"done"}',
      '{"state":"done","stateStartedAt":"5"}',
      '{"stateStartedAt":5}',
      'null'
    ]) {
      const parsed = parseAgentStatusPayload(
        `{"state":"working","prompt":"keep me","mainAgent":${mainAgent}}`
      )
      expect(parsed, mainAgent).toMatchObject({ state: 'working', prompt: 'keep me' })
      expect(parsed?.mainAgent, mainAgent).toBeUndefined()
    }
  })
})
