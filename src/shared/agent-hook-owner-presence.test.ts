import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkHookOwnerPresence, readHookProcessVerdict } from './agent-hook-owner-presence'
import { createHookListenerState } from './agent-hook-listener/listener-state'
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
    () => new Promise((resolve) => setTimeout(() => resolve(verdict), ms))
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
  event: string
): Promise<number> {
  const started = performance.now()
  let settled = false
  const pending = checkHookOwnerPresence(
    state,
    'claude',
    body(event),
    'production',
    async () => {},
    read
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

  it('lets a stale root verdict lapse rather than certify a changed foreground', async () => {
    const state = createHookListenerState()
    const read = slowReader(800, 'root')
    await preflight(state, read, 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(readHookProcessVerdict(state, undefined, { paneKey: PANE, process: PROCESS })).toBe(
      'unknown'
    )
    await preflight(state, read, 'PostToolUse')
    expect(read).toHaveBeenCalledTimes(2)
  })
})
