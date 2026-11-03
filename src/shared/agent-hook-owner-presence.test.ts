import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkHookOwnerPresence,
  readHookProcessVerdict,
  restateHookRoot,
  type HookRootCompletion
} from './agent-hook-owner-presence'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentProcessPresence } from './agent-process-presence'
import type { HookProcessVerdict, HookRootEvidenceReader } from './hook-process-root-evidence'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const PROCESS = { pid: 49969, platform: 'darwin' as const, startTime: 'Sun Nov  1 00:01:23 2026' }

beforeEach(() => {
  // Hook deadlines run on the monotonic clock, so it is faked with the timers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

/** Evidence that completes `ms` after it starts, the way a slow host's reads do. */
function slowReader(ms: number, verdict: HookProcessVerdict) {
  return vi.fn<HookRootEvidenceReader>(
    // ast-grep-ignore: test-no-real-time-wait -- fake timers drive this simulated read delay
    () => new Promise((resolve) => setTimeout(() => resolve({ verdict }), ms))
  )
}

function body(event: string) {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agentProcess: JSON.stringify(PROCESS),
    payload: { hook_event_name: event, session_id: 'session-a' }
  }
}

/** One hook's preflight; resolves to how long the hook waited for evidence. */
async function preflight(
  state: ReturnType<typeof createHookListenerState>,
  read: HookRootEvidenceReader,
  event: string,
  reconcile?: (completion: HookRootCompletion) => void
): Promise<number> {
  const started = performance.now()
  let settled = false
  const hookBody = body(event)
  const pending = checkHookOwnerPresence(
    state,
    'claude',
    event === 'SessionEnd'
      ? { ...hookBody, payload: { ...hookBody.payload, reason: 'prompt_input_exit' } }
      : hookBody,
    'production',
    async () => {},
    { read, reconcile }
  )
  void pending?.then(() => {
    settled = true
  })
  while (pending && !settled) {
    await vi.advanceTimersByTimeAsync(10)
  }
  return performance.now() - started
}

describe('hook acquisition deadlines on a slow host', () => {
  it.each([[800], [2_000]])(
    'waits once for %i ms evidence, then later hooks use its late result without waiting',
    async (ms) => {
      const state = createHookListenerState()
      const read = slowReader(ms, 'root')
      expect(await preflight(state, read, 'UserPromptSubmit')).toBeLessThanOrEqual(510)
      // The answer missed this hook's deadline; it grants nothing yet.
      expect(readHookProcessVerdict(state, undefined, { paneKey: PANE, process: PROCESS })).toBe(
        'unknown'
      )
      // Tool hooks while the read runs join it without a fresh wait.
      for (let index = 0; index < 3; index++) {
        expect(await preflight(state, read, 'PreToolUse')).toBeLessThanOrEqual(10)
      }
      await vi.advanceTimersByTimeAsync(ms)
      // A sparse hook long after still consumes the completed evidence, with no new read.
      await vi.advanceTimersByTimeAsync(1_400)
      expect(await preflight(state, read, 'PostToolUse')).toBe(0)
      expect(readHookProcessVerdict(state, undefined, { paneKey: PANE, process: PROCESS })).toBe(
        'root'
      )
      expect(read).toHaveBeenCalledOnce()
    }
  )

  it.each([[800], [2_000]])(
    'keeps a late %i ms root through hooks 15 s apart, and hands it to the host at once',
    async (ms) => {
      const state = createHookListenerState()
      const read = slowReader(ms, 'root')
      const reconcile = vi.fn()
      expect(await preflight(state, read, 'UserPromptSubmit', reconcile)).toBeLessThanOrEqual(510)
      await vi.advanceTimersByTimeAsync(ms)
      // The host heals the pane as the answer lands, before any later hook.
      expect(reconcile).toHaveBeenCalledOnce()
      for (const event of ['PostToolUse', 'UserPromptSubmit', 'Stop']) {
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await preflight(state, read, event, reconcile)).toBe(0)
        expect(readHookProcessVerdict(state, undefined, { paneKey: PANE, process: PROCESS })).toBe(
          'root'
        )
      }
      // A turn retries in the background (one per turn at most); no hook waits for it.
      expect(read.mock.calls.length).toBeLessThanOrEqual(2)
    }
  )

  it('gives a process one answer wait: a later turn’s retry never blocks', async () => {
    const state = createHookListenerState()
    const read = slowReader(2_000, 'unknown')
    expect(await preflight(state, read, 'SessionStart')).toBeLessThanOrEqual(510)
    await vi.advanceTimersByTimeAsync(2_000)
    for (let turn = 0; turn < 3; turn++) {
      expect(await preflight(state, read, 'UserPromptSubmit')).toBe(0)
      for (let index = 0; index < 5; index++) {
        expect(await preflight(state, read, 'PostToolUse')).toBe(0)
      }
      await vi.advanceTimersByTimeAsync(2_000)
    }
    expect(read).toHaveBeenCalledTimes(4)
  })
})

describe('the executor’s aggregate attempt budget', () => {
  it('starts no duplicate read, answers overload at once and never evicts an unfinished read', async () => {
    const state = createHookListenerState()
    const read = vi.fn<HookRootEvidenceReader>(() => new Promise(() => {}))
    const hookOf = (pid: number) => ({
      ...body('UserPromptSubmit'),
      agentProcess: JSON.stringify({ ...PROCESS, pid })
    })
    const waits = Array.from({ length: 300 }, (_, index) =>
      checkHookOwnerPresence(state, 'claude', hookOf(1000 + index), 'production', async () => {}, {
        read
      })
    )
    expect(read).toHaveBeenCalledTimes(64)
    // Past the bound a hook waits for nothing and reads as unproven, never refused.
    expect(waits.slice(64).every((wait) => wait === undefined)).toBe(true)
    expect(
      readHookProcessVerdict(state, undefined, {
        paneKey: PANE,
        process: { ...PROCESS, pid: 1299 }
      })
    ).toBe('unknown')
    checkHookOwnerPresence(state, 'claude', hookOf(1000), 'production', async () => {}, { read })
    expect(read).toHaveBeenCalledTimes(64)
    const pending = [...state.hookRootAttempts.values()].filter((attempt) => attempt.pending)
    expect(pending).toHaveLength(64)
    expect(state.hookRootAttempts.size).toBeLessThanOrEqual(256 + 64)
    await vi.advanceTimersByTimeAsync(600)
  })
})

describe('a late answer’s reconciliation', () => {
  const row = (agentPresence: AgentProcessPresence): AgentHookEventPayload => ({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    agentPresence,
    payload: { state: 'working', prompt: 'Task', agentType: 'claude' }
  })
  const weak = { agent: 'claude', session: 'older' }
  const proved = { agent: 'claude', process: PROCESS, sessionOwner: true as const }

  it.each<[string, string, HookProcessVerdict, AgentProcessPresence, unknown]>([
    ['acquires an unchanged unproven record', 'UserPromptSubmit', 'root', weak, proved],
    [
      'keeps a compatible status update’s record and retires it on the owed exit',
      'SessionEnd',
      'root',
      { ...weak, session: 'newer' },
      { ...proved, ended: true }
    ],
    [
      'leaves a successor admitted meanwhile',
      'UserPromptSubmit',
      'root',
      { agent: 'claude', process: { ...PROCESS, pid: 5000 }, sessionOwner: true },
      undefined
    ],
    [
      'withdraws its own fallback once proved status-only',
      'UserPromptSubmit',
      'unattached',
      { ...proved, fallback: true },
      proved
    ],
    [
      'keeps its own fallback suspended as it upgrades',
      'UserPromptSubmit',
      'root',
      { ...proved, fallback: true, suspended: true },
      { ...proved, suspended: true }
    ],
    ['changes nothing for a still-unproven answer', 'UserPromptSubmit', 'unknown', weak, undefined]
  ])('%s', async (_name, event, verdict, later, expected) => {
    const rows = new Map([[PANE, row(weak)]])
    const state = { ...createHookListenerState(), lastStatusByPaneKey: rows }
    const completions: HookRootCompletion[] = []
    const results: unknown[] = []
    const read = slowReader(800, verdict)
    await preflight(state, read, event, (completion) => {
      completions.push(completion)
      // The host applies the answer before the attempt forgets its exit intent.
      results.push(restateHookRoot(state, completion)?.agentPresence)
    })
    rows.set(PANE, row(later))
    await vi.advanceTimersByTimeAsync(800)
    expect(completions).toHaveLength(1)
    expect(results).toEqual([expected])
  })
})
