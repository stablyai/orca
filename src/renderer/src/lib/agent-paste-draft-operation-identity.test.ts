import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from '../../../main/runtime/generated-agent-input-notices'

const h = vi.hoisted(() => ({
  notices: null as GeneratedAgentInputNotices | null,
  answerAfterMs: 0,
  rpc: vi.fn(),
  host: vi.fn(),
  fallback: vi.fn()
}))
// This window's runtime: the real owner, answering a final registration only after a delay.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => h.rpc(...args),
  runtimeEnvironmentSupportsCapability: async () => false
}))
vi.mock('@/runtime/generated-terminal-input-client', () => ({
  sendGeneratedTerminalInput: (...args: unknown[]) => h.host(...args)
}))
vi.mock('@/runtime/generated-input-notice-toast-projection', () => ({
  projectFallbackGeneratedInputNotice: (...args: unknown[]) => h.fallback(...args)
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ ptyIdsByTabId: {}, tabsByWorktree: {} }),
    subscribe: () => () => {}
  }
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'codex' }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), dismiss: vi.fn() } }))

const { pasteDraftToAgentPtyWhenReady } = await import('./agent-paste-draft')

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  const notices = new GeneratedAgentInputNotices()
  h.notices = notices
  h.answerAfterMs = 6000
  h.fallback.mockClear()
  h.host.mockReset()
  h.rpc.mockImplementation(
    async (_target: unknown, _method: string, params: Record<string, unknown>) => {
      if (params.settle) {
        notices.settle(String(params.id), 'window')
        return { settled: true }
      }
      const kept = notices.upsert({
        ...(params as unknown as Parameters<GeneratedAgentInputNotices['upsert']>[0]),
        origin: 'window',
        handle: '',
        worktreeId: ''
      })
      if (!params.pending && h.answerAfterMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, h.answerAfterMs))
      }
      return kept
    }
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const frames = () => h.notices!.page(0, 0, 'window').frames.map(({ id, chunk }) => ({ id, chunk }))

// XR5: the host refused, the window's runtime kept the notice at once but its answer took six
// seconds against the five-second wait. That is one operation: one record and, when shown
// directly, the same id and intent, never a second copy of the text.
it('keeps one operation when the registration answer outlasts the wait', async () => {
  h.host.mockResolvedValue('not-sent')
  const result = pasteDraftToAgentPtyWhenReady({
    ptyId: 'pty',
    content: 'exact text',
    agent: 'codex',
    submit: false,
    forcePaste: true,
    timeoutMs: 1000
  })
  await vi.advanceTimersByTimeAsync(5001)
  await expect(result).resolves.toBe(false)
  const [operation] = frames()
  expect(frames()).toEqual([{ id: operation.id, chunk: 'exact text' }])
  await vi.advanceTimersByTimeAsync(12_000)
  expect(frames()).toEqual([{ id: operation.id, chunk: 'exact text' }])
  expect(h.fallback.mock.calls).toEqual([
    [expect.objectContaining({ operationId: operation.id, text: 'exact text', submitted: false })]
  ])
})

// Two user actions with the same text stay two operations.
it('keeps two accepted operations with identical text apart', async () => {
  h.answerAfterMs = 0
  h.host.mockResolvedValue('not-sent')
  const paste = () =>
    pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty',
      content: 'same text',
      agent: 'codex',
      submit: true,
      forcePaste: true
    })
  await Promise.all([paste(), paste()])
  const ids = frames().map(({ id }) => id)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
})

// L1 kept: a hung registration never delays a ready send.
it('sends at once while the registration never answers', async () => {
  h.rpc.mockImplementation(() => new Promise(() => {}))
  h.host.mockResolvedValue('delivered')
  const result = pasteDraftToAgentPtyWhenReady({
    ptyId: 'pty',
    content: 'exact',
    agent: 'codex',
    submit: true,
    forcePaste: true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.host).toHaveBeenCalledTimes(1)
  await expect(result).resolves.toBe(true)
})

// A supplied refusal handler learns the same accepted id, so its own notice is that operation;
// and once that operation was dismissed, a later keep answer never shows it again.
it('gives the caller’s refusal handler the accepted id, and shows nothing once it was dismissed', async () => {
  h.answerAfterMs = 0
  h.host.mockResolvedValue('not-sent')
  const onTimeout = vi.fn()
  await pasteDraftToAgentPtyWhenReady({
    ptyId: 'pty',
    content: 'exact',
    agent: 'codex',
    submit: true,
    forcePaste: true,
    onTimeout
  })
  const [operation] = frames()
  expect(onTimeout).toHaveBeenCalledExactlyOnceWith('not-sent', true, operation.id)
  h.notices!.dismiss(operation.id, 'window')
  const { noticeGeneratedInputFailure } = await import('./launch-agent-paste-timeout-notice')
  noticeGeneratedInputFailure({ agent: 'codex', text: 'exact', operationId: operation.id })
  await vi.advanceTimersByTimeAsync(6000)
  expect(h.fallback).not.toHaveBeenCalled()
  expect(frames()).toEqual([])
})
