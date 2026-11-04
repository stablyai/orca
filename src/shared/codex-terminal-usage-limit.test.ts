import { afterEach, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept } from './agent-hook-listener/normalization/agent-hook-listener-test-harness'
import { pollCodexTranscriptStatus } from './agent-hook-listener/providers/codex-transcript-poll'
import {
  createCodexSubagentTranscriptState,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import {
  reconcileCodexTerminalUsageLimit,
  type CodexTerminalUsageLimitTurn
} from './codex-terminal-usage-limit'

const NOW = 1_793_752_550_000
const RESET_SECONDS = 1_793_756_137
const event = (payload: Record<string, unknown>) => ({ type: 'event_msg', payload })
const start = event({
  type: 'task_started',
  turn_id: 'root',
  root_turn_id: 'root',
  turn_attribution: { turn_id: 'root', parent_turn_id: null, root_turn_id: 'root' }
})
// Recorded Codex 0.165.0 serialization against a synthetic quota provider.
const limits = event({
  type: 'token_count',
  info: null,
  rate_limits: {
    limit_id: 'codex',
    primary: { used_percent: 100, window_minutes: 300, resets_at: RESET_SECONDS },
    secondary: null,
    plan_type: null,
    rate_limit_reached_type: null
  }
})
const end = event({
  type: 'task_complete',
  turn_id: 'root',
  root_turn_id: 'root',
  error: { codex_error_info: 'usage_limit_exceeded' }
})

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
function rollout() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-terminal-quota-'))
  directories.push(directory)
  return { directory, path: join(directory, 'rollout.jsonl') }
}

it('retains the typed latest-root quota and converts the recorded reset seconds', () => {
  const turn: CodexTerminalUsageLimitTurn = {}
  reconcileCodexTerminalUsageLimit(turn, [start, limits], NOW)
  expect(turn.usageLimit).toBeUndefined()
  reconcileCodexTerminalUsageLimit(turn, [end], NOW)
  expect(turn.usageLimit).toEqual({ window: 'session', resetsAt: RESET_SECONDS * 1000 })
})

it('does not turn a percentage or transient throttle into a quota failure', () => {
  const turn: CodexTerminalUsageLimitTurn = {}
  reconcileCodexTerminalUsageLimit(
    turn,
    [start, limits, event({ ...end.payload, error: { codex_error_info: 'rate_limit_exceeded' } })],
    NOW
  )
  expect(turn.usageLimit).toBeUndefined()
})

it('clears evidence at a newer root and never borrows its predecessor’s reset', () => {
  const turn: CodexTerminalUsageLimitTurn = {}
  reconcileCodexTerminalUsageLimit(turn, [start, limits, end, start], NOW)
  expect(turn.usageLimit).toBeUndefined()
  reconcileCodexTerminalUsageLimit(turn, [end], NOW)
  expect(turn.usageLimit).toEqual({})
})

it('does not borrow an account reset after an unsupported limit bucket replaces it', () => {
  const turn: CodexTerminalUsageLimitTurn = {}
  reconcileCodexTerminalUsageLimit(
    turn,
    [start, limits, event({ ...limits.payload, rate_limits: { limit_id: 'other' } }), end],
    NOW
  )
  expect(turn.usageLimit).toEqual({})
})

it('does not promote child turns or unbounded historical quota into the root', () => {
  const turn: CodexTerminalUsageLimitTurn = {}
  reconcileCodexTerminalUsageLimit(turn, [limits, end], NOW)
  expect(turn.usageLimit).toBeUndefined()
  reconcileCodexTerminalUsageLimit(
    turn,
    [event({ ...start.payload, turn_attribution: { parent_turn_id: 'parent' } }), limits, end],
    NOW
  )
  expect(turn.usageLimit).toBeUndefined()
})

it('publishes quota from the rollout and clears it when a native newer turn appears before its hook', () => {
  const { path } = rollout()
  writeFileSync(path, jsonl([start]))
  const state = createHookListenerState()
  const hook = { session_id: 'session', turn_id: 'root', transcript_path: path }
  normalizeAndAccept(state, 'codex', {
    ...hook,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Finish'
  })
  appendFileSync(path, jsonl([limits, end]))
  const failed = normalizeAndAccept(state, 'codex', { ...hook, hook_event_name: 'Stop' })!
  expect(failed.payload.mainAgent).toMatchObject({
    state: 'done',
    outcome: 'failure',
    usageLimit: {}
  })
  appendFileSync(path, jsonl([event({ type: 'task_started', turn_id: 'newer' })]))
  const next = pollCodexTranscriptStatus(state, failed, { payload: hook }, 'production')
  expect(next?.payload.mainAgent?.usageLimit).toBeUndefined()
})

it('drops per-turn quota evidence when its cursor loses continuity or the file disappears', () => {
  const { path, directory } = rollout()
  const state = createCodexSubagentTranscriptState()
  const roster = new Map()
  writeFileSync(path, jsonl([start, limits, end]))
  reconcileCodexSubagentTranscript(state, roster, path)
  expect(state.usageLimitTurn.usageLimit).toBeDefined()
  const replacement = join(directory, 'replacement.jsonl')
  writeFileSync(replacement, jsonl([end]))
  renameSync(replacement, path)
  reconcileCodexSubagentTranscript(state, roster, path)
  expect(state.usageLimitTurn.usageLimit).toBeUndefined()
  writeFileSync(replacement, jsonl([start, limits, end]))
  renameSync(replacement, path)
  reconcileCodexSubagentTranscript(state, roster, path)
  expect(state.usageLimitTurn.usageLimit).toBeDefined()
  rmSync(path)
  reconcileCodexSubagentTranscript(state, roster, path)
  expect(state.usageLimitTurn.usageLimit).toBeUndefined()
})
