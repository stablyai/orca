// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useGitStatusWindowPresence } from './use-git-status-window-presence'
import { useGitStatusTurnCompletion } from './use-git-status-turn-completion'
import { createGitStatusRefreshScheduler } from './git-status-refresh-scheduler'
import { resetStructuredAgentSessionTurnCompletionFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-turn-completion-feed'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AgentSessionTurnCompletionEvent } from '../../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { Tab } from '../../../../../../shared/tab-types'

const transport = vi.hoisted(() => ({ open: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionTurnCompletions: transport.open
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: transport.supports
}))
let root: Root
let visibility: DocumentVisibilityState
const leaf = '11111111-1111-4111-8111-111111111111'
const signals: string[] = []
const renders = new Map<string, number>()
const stops: string[] = []
const sends = new Map<string, (event: AgentSessionTurnCompletionEvent) => void>()
const schedulers = new Map<string, ReturnType<typeof createGitStatusRefreshScheduler>>()
const target: RuntimeClientTarget = { kind: 'local' }
function Observer({
  id,
  host,
  structured = false
}: {
  id: string
  host: ExecutionHostId
  structured?: boolean
}) {
  renders.set(id, (renders.get(id) ?? 0) + 1)
  let scheduler = schedulers.get(id)
  if (!scheduler) {
    scheduler = createGitStatusRefreshScheduler(
      async () => {
        signals.push(id)
      },
      {
        safetyIntervalMs: 60_000,
        activityDebounceMs: 125,
        activityMinGapMs: 3000,
        slowTaskBackoff: { idleMultiplier: 1, changeSignalMultiplier: 1, maxIntervalMs: 300_000 }
      }
    )
    schedulers.set(id, scheduler)
  }
  useGitStatusTurnCompletion(structured ? target : null, host, id, true, { current: scheduler })
  return null
}
function tab(id: string, worktreeId: string, executionHostId?: ExecutionHostId): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group',
    worktreeId,
    executionHostId,
    contentType: 'terminal',
    label: 'agent',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function write(id: string, worktreeId: string, done: boolean) {
  useAppStore.getState().setAgentStatus(
    `${id}:${leaf}`,
    { state: done ? 'done' : 'working', prompt: 'implement fix', agentType: 'codex' },
    undefined,
    {
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      ...(done ? { turnEndedAt: Date.now() } : {})
    },
    { tabId: id, worktreeId }
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  useAppStore.setState(useAppStore.getInitialState(), true)
  signals.length = 0
  stops.length = 0
  sends.clear()
  renders.clear()
  transport.open.mockClear()
  transport.supports.mockResolvedValue(true)
  transport.open.mockImplementation(
    async (owner: RuntimeClientTarget, send: (event: AgentSessionTurnCompletionEvent) => void) => {
      const key = owner.kind === 'local' ? 'local' : owner.environmentId
      sends.set(key, send)
      return {
        unsubscribe: () => {
          stops.push(key)
          sends.delete(key)
        }
      }
    }
  )
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const scheduler of schedulers.values()) {
    scheduler.dispose()
  }
  schedulers.clear()
  resetStructuredAgentSessionTurnCompletionFeedsForTests()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('routes accepted terminal turn ends to local, runtime and SSH copies, including legacy local tabs', async () => {
  const specs = [
    { id: 'folder', host: 'local' as const, pty: 'local-pty' },
    { id: 'runtime', host: 'runtime:env' as const, pty: 'remote:env@@pty' },
    { id: 'ssh', host: 'ssh:server' as const, pty: 'ssh:server@@pty' }
  ]
  useAppStore.setState({
    unifiedTabsByWorktree: Object.fromEntries(specs.map((s) => [s.id, [tab(s.id, s.id)]])),
    ptyIdsByTabId: Object.fromEntries(specs.map((s) => [s.id, [s.pty]]))
  })
  await act(async () =>
    root.render(
      <>
        {specs.map((s) => (
          <Observer key={s.id} id={s.id} host={s.host} />
        ))}
        <Observer id="folder" host="runtime:other" />
      </>
    )
  )
  for (const spec of specs) {
    write(spec.id, spec.id, false)
  }
  await vi.advanceTimersByTimeAsync(1)
  for (const spec of specs) {
    write(spec.id, spec.id, true)
  }
  await vi.advanceTimersByTimeAsync(125)
  expect(signals.sort()).toEqual(['folder', 'runtime', 'ssh'])
  signals.length = 0
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(4000)
  for (const spec of specs) {
    write(spec.id, spec.id, false)
    write(spec.id, spec.id, true)
  }
  await vi.advanceTimersByTimeAsync(125)
  expect(signals).toEqual([])
})

it.each([10, 100])(
  'shares the producer and scopes updates for %i interested observers',
  async (count) => {
    await act(async () =>
      root.render(
        <>
          {Array.from({ length: count }, (_, i) => (
            <Observer key={i} id={`observer-${i}`} host="local" structured />
          ))}
        </>
      )
    )
    expect(transport.open).toHaveBeenCalledTimes(1)
    const settledRenders = [...renders]
    await act(async () => useAppStore.setState({ rightSidebarOpen: true }))
    expect([...renders]).toEqual(settledRenders)
    const send = sends.get('local')!
    send({
      type: 'completion',
      completion: {
        scope: {
          executionHostId: 'local',
          workspaceId: 'observer-1',
          workspaceKind: 'folder',
          wslDistro: null
        },
        sessionId: 'session',
        turnId: 'turn',
        outcome: 'success',
        completedAt: Date.now()
      }
    })
    await vi.advanceTimersByTimeAsync(125)
    expect(signals).toEqual(['observer-1'])
    expect([...renders]).toEqual(settledRenders)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stops).toEqual(['local'])
    expect(sends.size).toBe(0)
    signals.length = 0
    send({
      type: 'completion',
      completion: {
        scope: {
          executionHostId: 'local',
          workspaceId: 'observer-0',
          workspaceKind: 'folder',
          wslDistro: null
        },
        sessionId: 'session',
        turnId: 'late',
        outcome: 'success',
        completedAt: Date.now()
      }
    })
    await vi.advanceTimersByTimeAsync(125)
    expect(signals).toEqual([])
  }
)

it('catches up on system wake and reveal, but adds no idle read on focus', async () => {
  let wake: (() => void) | undefined
  vi.stubGlobal('api', {
    ui: {
      onSystemResumed: (listener: () => void) => {
        wake = listener
        return () => {
          wake = undefined
        }
      }
    }
  })
  const reads: number[] = []
  const scheduler = createGitStatusRefreshScheduler(
    async () => {
      reads.push(Date.now())
    },
    {
      safetyIntervalMs: 60_000,
      activityDebounceMs: 125,
      activityMinGapMs: 3000,
      slowTaskBackoff: { idleMultiplier: 1, changeSignalMultiplier: 1, maxIntervalMs: 300_000 }
    }
  )
  schedulers.set('presence', scheduler)
  const ref = { current: scheduler }
  function Presence() {
    useGitStatusWindowPresence(ref, true, 'local/folder')
    return null
  }
  await act(async () => root.render(<Presence />))
  await vi.advanceTimersByTimeAsync(10_000)
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(0)
  expect(reads).toEqual([2_000_000])
  wake?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(reads).toEqual([2_000_000, 2_010_000])
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  wake?.()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(reads).toEqual([2_000_000, 2_010_000])
  visibility = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(reads).toEqual([2_000_000, 2_010_000, 2_020_000])
})
