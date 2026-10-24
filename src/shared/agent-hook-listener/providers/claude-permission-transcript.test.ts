import { afterEach, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { cacheRelayLegacyAgentStatus } from '../../agent-status-legacy-relay-cache'
import { createHookListenerState } from '../listener-state'
import {
  applyClaudePermissionTranscript,
  pollClaudePermissionTranscript
} from './claude-permission-transcript'
import { applyRelayHookEvent } from '../../../wsl-guest/agent-hook-event-admission'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([10, 100])(
  'isolates proposals from %i unrelated panes and commits only admitted updates',
  (count) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'permission-proposal-'))
    directories.push(directory)
    const transcript = join(directory, 'session.jsonl')
    const fixture = readFileSync(
      join(__dirname, '../../__fixtures__/claude-permission-escape.jsonl'),
      'utf8'
    )
    writeFileSync(transcript, `${fixture.split('\n').slice(0, 3).join('\n')}\n`)
    const state = createHookListenerState()
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const post = (payload: Record<string, unknown>) => {
      const event = normalizeHookPayload(
        state,
        'claude',
        {
          paneKey,
          tabId: 'tab-1',
          payload: {
            session_id: '00000000-0000-4000-8000-000000000000',
            transcript_path: transcript,
            ...payload
          }
        },
        'production'
      )
      if (!event) {
        throw new Error('missing event')
      }
      expect(cacheRelayLegacyAgentStatus(state, event, 256, () => {})).toBe(true)
      return event
    }
    post({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01QFGUSJNpFMqWgCSxXKSoRJ',
      tool_input: {
        command: 'printf permission_probe > escape2-probe.txt',
        description: 'Write probe text to a file'
      }
    })
    const original = post({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {
        command: 'printf permission_probe > escape2-probe.txt',
        description: 'Write probe text to a file'
      }
    })
    let visited = 0
    class CountedMap<V> extends Map<string, V> {
      override *[Symbol.iterator](): MapIterator<[string, V]> {
        for (const entry of super[Symbol.iterator]()) {
          visited++
          yield entry
        }
      }
    }
    for (let i = 0; i < count; i++) {
      state.claudeLeadStateByPaneKey.set(`other-${i}`, { state: 'done', stateStartedAt: 1 })
      state.lastToolByPaneKey.set(`other-${i}`, {})
    }
    state.claudeLeadStateByPaneKey = new CountedMap(state.claudeLeadStateByPaneKey)
    state.lastToolByPaneKey = new CountedMap(state.lastToolByPaneKey)
    const lead = state.claudeLeadStateByPaneKey.get(paneKey)
    const tool = state.lastToolByPaneKey.get(paneKey)
    visited = 0
    const proposal = pollClaudePermissionTranscript(state, original)
    if (!proposal) {
      throw new Error('missing proposal')
    }
    expect(visited).toBe(0)
    const host = {
      state,
      metadata: new Map(),
      isCanonicalPane: () => true,
      isPaneSurfaceRetired: () => false,
      clearPaneState: () => {},
      clearAssistantMessageRetry: () => {},
      forward: () => {},
      checkAgentPresence: async () => {}
    }
    expect(
      applyRelayHookEvent(host, proposal.event, 'claude', 'production', undefined, {
        onAccepted: proposal.onAccepted
      })
    ).toBeUndefined()
    expect(state.claudeLeadStateByPaneKey.get(paneKey)).toBe(lead)
    expect(state.lastToolByPaneKey.get(paneKey)).toBe(tool)
    expect(pollClaudePermissionTranscript(state, original)?.event.payload).toEqual(
      proposal.event.payload
    )
    const admitted = applyRelayHookEvent(
      { ...host, isCanonicalPane: () => false },
      proposal.event,
      'claude',
      'production',
      undefined,
      { onAccepted: proposal.onAccepted }
    )
    expect(state.claudeLeadStateByPaneKey.get(paneKey)).toMatchObject({
      state: 'working'
    })
    expect(state.lastToolByPaneKey.get(paneKey)?.toolName).toBeUndefined()
    if (!admitted) {
      throw new Error('proposal not admitted')
    }
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        isSidechain: false,
        sessionId: original.providerSession?.id,
        uuid: 'new-prompt',
        parentUuid: 'escape2-node-3',
        message: { role: 'user', content: 'Continue working' }
      })}\n`
    )
    // Already working: retire the old observer without another status write or late verdict.
    expect(pollClaudePermissionTranscript(state, admitted)).toBeUndefined()
    expect(state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(false)
    expect(state.claudeLeadStateByPaneKey.get('other-0')).toEqual({
      state: 'done',
      stateStartedAt: 1
    })
  }
)

const sessionId = '00000000-0000-4000-8000-000000000000'
const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
function proofHarness(recovered = false) {
  const directory = mkdtempSync(join(tmpdir(), 'permission-proof-'))
  directories.push(directory)
  const transcript = join(directory, 'session.jsonl')
  const lines = readFileSync(
    join(__dirname, '../../__fixtures__/claude-permission-escape.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
  writeFileSync(transcript, recovered ? '' : `${lines[0]}\n`)
  const state = createHookListenerState()
  const original = normalizeHookPayload(
    state,
    'claude',
    {
      paneKey,
      tabId: 'tab-1',
      payload: {
        session_id: sessionId,
        transcript_path: transcript,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {
          command: 'printf permission_probe > escape2-probe.txt',
          description: 'Write probe text to a file'
        }
      }
    },
    'production'
  )
  if (!original) {
    throw new Error('missing permission')
  }
  cacheRelayLegacyAgentStatus(state, original, 256, () => {})
  const host = {
    state,
    metadata: new Map(),
    isCanonicalPane: () => false,
    isPaneSurfaceRetired: () => false,
    clearPaneState: () => {},
    clearAssistantMessageRetry: () => {},
    forward: () => {},
    checkAgentPresence: async () => {}
  }
  const apply = (event: typeof original, onAccepted: () => void) =>
    applyRelayHookEvent(host, event, 'claude', 'production', undefined, { onAccepted })
  return { state, original, transcript, lines, apply }
}
const jsonLine = (row: Record<string, unknown>) => `${JSON.stringify(row)}\n`
function chain(parentUuid: string, count = 520) {
  return Array.from({ length: count }, (_, i) =>
    jsonLine({
      type: 'attachment',
      isSidechain: false,
      sessionId,
      uuid: `chain-${i}`,
      parentUuid: i ? `chain-${i - 1}` : parentUuid
    })
  ).join('')
}

it('bounds lost-proof recovered-ID admission using stored rows; rejection, holds and owner changes retire without cache writes', () => {
  for (const failure of [
    'none',
    'reject-bind',
    'hold-bind',
    'reject-settle',
    'hold-settle',
    'owner'
  ]) {
    const h = proofHarness(true)
    appendFileSync(h.transcript, `${h.lines.join('\n')}\n${chain('escape2-node-6')}`)
    const lead = h.state.claudeLeadStateByPaneKey.get(paneKey)
    const tool = h.state.lastToolByPaneKey.get(paneKey)
    let calls = 0
    let boundLead = lead
    let boundTool = tool
    applyClaudePermissionTranscript(h.state, h.original, (event, onAccepted) => {
      calls++
      if (calls === 2) {
        expect(h.state.lastStatusByPaneKey.get(paneKey)?.toolUseId).toBe(event.toolUseId)
        expect(event.claudeSettledRequests).toHaveLength(1)
        expect(event.payload.mainAgent?.outcome).toBeUndefined()
      }
      if (failure === (calls === 1 ? 'reject-bind' : 'reject-settle')) {
        return undefined
      }
      if (failure === (calls === 1 ? 'hold-bind' : 'hold-settle')) {
        return h.state.lastStatusByPaneKey.get(paneKey)
      }
      const next = h.apply(event, onAccepted)
      if (calls === 1) {
        boundLead = h.state.claudeLeadStateByPaneKey.get(paneKey)
        boundTool = h.state.lastToolByPaneKey.get(paneKey)
        if (failure === 'owner') {
          cacheRelayLegacyAgentStatus(h.state, h.original, 256, () => {})
        }
      }
      return next
    })
    expect(calls).toBe(failure.endsWith('bind') || failure === 'owner' ? 1 : 2)
    expect(h.state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(false)
    expect(pollClaudePermissionTranscript(h.state, h.original)).toBeUndefined()
    if (failure !== 'none') {
      expect(h.state.claudeLeadStateByPaneKey.get(paneKey)).toBe(boundLead)
      expect(h.state.lastToolByPaneKey.get(paneKey)).toBe(boundTool)
    } else {
      expect(h.state.lastStatusByPaneKey.get(paneKey)?.payload.mainAgent?.state).toBe('working')
    }
  }
  const h = proofHarness()
  appendFileSync(h.transcript, chain('escape2-node-1'))
  expect(applyClaudePermissionTranscript(h.state, h.original, h.apply)).toBe(h.original)
  expect(h.state.lastStatusByPaneKey.get(paneKey)?.payload.state).toBe('waiting')
  expect(h.state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(false)
})

it('qualifies immutable proposals, trailing records and unreadable retries without reviving cached cancellation', () => {
  for (const fragment of ['interruption', 'new-prompt']) {
    const h = proofHarness()
    const tail =
      fragment === 'interruption'
        ? `${h.lines[4]}\n${h.lines[5]}\n`
        : jsonLine({
            type: 'user',
            isSidechain: false,
            sessionId,
            uuid: 'p2',
            parentUuid: 'escape2-node-6',
            promptId: 'p2',
            message: { content: 'new work' }
          })
    const prefix = fragment === 'interruption' ? h.lines.slice(1, 4) : h.lines.slice(1)
    const cut = Math.floor(tail.indexOf('\n') / 2)
    appendFileSync(h.transcript, `${prefix.join('\n')}\n${tail.slice(0, cut)}`)
    const proposal = pollClaudePermissionTranscript(h.state, h.original)
    expect(proposal?.event.payload.mainAgent).toMatchObject({ state: 'working' })
    expect(proposal?.event.payload.mainAgent?.outcome).toBeUndefined()
    expect(
      pollClaudePermissionTranscript(h.state, h.original)?.event.payload.mainAgent?.state
    ).toBe('working')
    if (!proposal) {
      throw new Error('missing exact settlement')
    }
    const observation = h.state.claudePermissionObservationByPaneKey.get(paneKey)
    appendFileSync(h.transcript, tail.slice(cut))
    expect(
      pollClaudePermissionTranscript(h.state, h.original)?.event.payload.mainAgent?.state
    ).toBe(fragment === 'interruption' ? 'done' : 'working')
    const accepted = h.apply(proposal.event, proposal.onAccepted)
    expect(observation?.published).toBe('working') // Captured proposal, not decoder's later verdict.
    expect(h.state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(true)
    if (!accepted) {
      throw new Error('missing accepted row')
    }
    const late = pollClaudePermissionTranscript(h.state, accepted)
    if (fragment === 'interruption') {
      expect(late?.event.payload.mainAgent?.outcome).toBe('cancellation')
    } else {
      expect(late).toBeUndefined()
    }
  }
  const h = proofHarness()
  appendFileSync(h.transcript, `${h.lines.slice(1).join('\n')}\n`)
  expect(
    pollClaudePermissionTranscript(h.state, h.original)?.event.payload.mainAgent?.outcome
  ).toBe('cancellation')
  renameSync(h.transcript, `${h.transcript}.unavailable`)
  expect(pollClaudePermissionTranscript(h.state, h.original)).toBeUndefined()
  renameSync(`${h.transcript}.unavailable`, h.transcript)
  expect(
    pollClaudePermissionTranscript(h.state, h.original)?.event.payload.mainAgent?.outcome
  ).toBe('cancellation')
  renameSync(h.transcript, `${h.transcript}.unavailable`)
  for (let i = 0; i < 3; i++) {
    expect(pollClaudePermissionTranscript(h.state, h.original)).toBeUndefined()
  }
  expect(h.state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(false)
})

it('uses off-branch root work only to withdraw outcome; excludes sidechain, session, meta and compact-summary evidence', () => {
  for (const override of [
    {},
    { type: 'assistant' },
    { type: 'assistant', isMeta: true },
    { type: 'assistant', isCompactSummary: true },
    { isSidechain: true },
    { sessionId: 'other' },
    { isMeta: true },
    { isCompactSummary: true },
    { type: 'api-request-blob' }
  ]) {
    const h = proofHarness()
    const negative =
      Object.keys(override).length === 0 ||
      (override.type === 'assistant' && !override.isMeta && !override.isCompactSummary)
    appendFileSync(
      h.transcript,
      `${h.lines.slice(1).join('\n')}\n${jsonLine({
        type: 'user',
        isSidechain: false,
        sessionId,
        uuid: 'off-branch',
        parentUuid: null,
        promptId: 'p2',
        message: { content: [{ type: 'text', text: 'new work' }] },
        ...override
      })}`
    )
    const proposal = pollClaudePermissionTranscript(h.state, h.original)
    expect(proposal?.event.payload.mainAgent?.state).toBe(negative ? 'working' : 'done')
    expect(proposal?.event.providerPromptId).toBe(h.original.providerPromptId)
    expect(proposal?.event.payload.prompt).toBe(h.original.payload.prompt)
    expect(h.state.claudePermissionObservationByPaneKey.get(paneKey)?.proof).toBe(
      negative ? 'lost' : 'complete'
    )
  }
  const h = proofHarness()
  // Off-branch results/interruption cannot authorize request settlement or a verdict.
  appendFileSync(
    h.transcript,
    `${h.lines
      .slice(1)
      .map((raw) => raw.replaceAll('escape2-node-', 'off-branch-'))
      .join('\n')}\n`
  )
  expect(pollClaudePermissionTranscript(h.state, h.original)).toBeUndefined()
  expect(h.state.lastStatusByPaneKey.get(paneKey)?.payload.state).toBe('waiting')
})

it('retires lost proof already settled as Working without another admission, and rejects obsolete callbacks', () => {
  const h = proofHarness()
  appendFileSync(h.transcript, `${h.lines.slice(1, 3).join('\n')}\n`)
  const working = applyClaudePermissionTranscript(h.state, h.original, h.apply)
  if (!working) {
    throw new Error('missing working row')
  }
  appendFileSync(h.transcript, chain('escape2-node-3'))
  const apply = vi.fn(h.apply)
  expect(applyClaudePermissionTranscript(h.state, working, apply)).toBe(working)
  expect(apply).not.toHaveBeenCalled()
  expect(h.state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(false)
  const other = proofHarness()
  appendFileSync(other.transcript, `${other.lines.slice(1).join('\n')}\n`)
  const late = pollClaudePermissionTranscript(other.state, other.original)
  const lead = other.state.claudeLeadStateByPaneKey.get(paneKey)
  const tool = other.state.lastToolByPaneKey.get(paneKey)
  other.state.claudePermissionObservationByPaneKey.delete(paneKey)
  expect(late?.onAccepted()).toBe(false)
  expect(other.state.claudeLeadStateByPaneKey.get(paneKey)).toBe(lead)
  expect(other.state.lastToolByPaneKey.get(paneKey)).toBe(tool)
})

it('retires unanchored gap proof without a status write or retained retry debt', () => {
  const h = proofHarness()
  appendFileSync(
    h.transcript,
    `${h.lines.slice(1, 3).join('\n')}\nnot-json\n${h.lines.slice(3).join('\n')}\n`
  )
  const apply = vi.fn(h.apply)
  expect(applyClaudePermissionTranscript(h.state, h.original, apply)).toBe(h.original)
  expect(apply).not.toHaveBeenCalled()
  expect(h.state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(false)
  expect(h.state.lastStatusByPaneKey.get(paneKey)).toBe(h.original)
})
