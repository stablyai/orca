import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  CODEX_BACKFILL_GATE_MAX_WAIT_MS,
  CODEX_BACKFILL_GATE_REPOLL_MS,
  waitForCodexBackfillGate
} from './codex-backfill-spawn-gate'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// Timer discipline (load-bearing): flush the initial status() microtask with
// `await vi.advanceTimersByTimeAsync(0)` — never vi.runOnlyPendingTimersAsync(),
// which fires EVERY pending timer regardless of delay, including the
// 15-minute fail-open setTimeout the gate arms immediately, and would clear
// the gate prematurely in every still-pending test. Time-dependent behavior
// (re-poll, max wait) is advanced explicitly with the exact constant.

function createApi(initial: { pending: boolean; lastWatermark: string | null }): {
  api: Parameters<typeof waitForCodexBackfillGate>[0]['api']
  emit: (status: { pending: boolean; lastWatermark: string | null }) => void
  unsubscribed: () => boolean
} {
  let listener: ((s: { pending: boolean; lastWatermark: string | null }) => void) | null = null
  let unsubscribed = false
  return {
    api: {
      status: vi.fn(() => Promise.resolve(initial)),
      onStatusChanged: (cb) => {
        listener = cb
        return () => {
          unsubscribed = true
        }
      }
    },
    emit: (status) => listener?.(status),
    unsubscribed: () => unsubscribed
  }
}

it('clears immediately when not pending', async () => {
  const { api } = createApi({ pending: false, lastWatermark: null })
  const onClear = vi.fn()
  waitForCodexBackfillGate({ api, onWaiting: vi.fn(), onClear })
  await vi.advanceTimersByTimeAsync(0)
  expect(onClear).toHaveBeenCalledTimes(1)
})

it('waits while pending, then clears once on the completion event', async () => {
  const { api, emit, unsubscribed } = createApi({
    pending: true,
    lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl'
  })
  const onWaiting = vi.fn()
  const onClear = vi.fn()
  waitForCodexBackfillGate({ api, onWaiting, onClear })
  await vi.advanceTimersByTimeAsync(0)
  expect(onWaiting).toHaveBeenCalledWith({ lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl' })
  expect(onClear).not.toHaveBeenCalled()

  emit({ pending: false, lastWatermark: null })
  emit({ pending: false, lastWatermark: null })
  expect(onClear).toHaveBeenCalledTimes(1)
  expect(unsubscribed()).toBe(true)
})

it('re-polls as a belt over a missed event', async () => {
  const { api } = createApi({ pending: true, lastWatermark: null })
  const onClear = vi.fn()
  waitForCodexBackfillGate({ api, onWaiting: vi.fn(), onClear })
  await vi.advanceTimersByTimeAsync(0)
  ;(api!.status as ReturnType<typeof vi.fn>).mockResolvedValue({
    pending: false,
    lastWatermark: null
  })
  await vi.advanceTimersByTimeAsync(CODEX_BACKFILL_GATE_REPOLL_MS)
  expect(onClear).toHaveBeenCalledTimes(1)
})

it('fails open when the api is missing or the query rejects', async () => {
  const onClearMissing = vi.fn()
  waitForCodexBackfillGate({ api: undefined, onWaiting: vi.fn(), onClear: onClearMissing })
  expect(onClearMissing).toHaveBeenCalledTimes(1)

  const onClearError = vi.fn()
  waitForCodexBackfillGate({
    api: {
      status: () => Promise.reject(new Error('ipc down')),
      onStatusChanged: () => () => {}
    },
    onWaiting: vi.fn(),
    onClear: onClearError
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(onClearError).toHaveBeenCalledTimes(1)
})

it('dispose cancels silently without onClear', async () => {
  const { api, emit } = createApi({ pending: true, lastWatermark: null })
  const onClear = vi.fn()
  const dispose = waitForCodexBackfillGate({ api, onWaiting: vi.fn(), onClear })
  await vi.advanceTimersByTimeAsync(0)
  dispose()
  emit({ pending: false, lastWatermark: null })
  expect(onClear).not.toHaveBeenCalled()
})

it('fails open after the max wait even if still pending', async () => {
  // Why: the prewarm has real give-up paths and the scheduler never re-runs on
  // prewarm failure — a pane parked forever is worse than today's visible
  // failure (codex dies -> toast), so the gate must eventually let go.
  const { api } = createApi({ pending: true, lastWatermark: null })
  const onClear = vi.fn()
  waitForCodexBackfillGate({ api, onWaiting: vi.fn(), onClear })
  await vi.advanceTimersByTimeAsync(0)
  expect(onClear).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(CODEX_BACKFILL_GATE_MAX_WAIT_MS)
  expect(onClear).toHaveBeenCalledTimes(1)
})
