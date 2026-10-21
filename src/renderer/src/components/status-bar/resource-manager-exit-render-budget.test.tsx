// @vitest-environment happy-dom
import { createElement, Profiler, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonSession } from '@/components/status-bar/resource-usage-merge-types'

vi.mock('@/store', () => {
  const state = {
    memorySnapshot: null,
    memorySnapshotError: null,
    workspaceSessionReady: true,
    fetchMemorySnapshot: vi.fn(async () => {}),
    setActiveView: vi.fn(),
    openModal: vi.fn(),
    openSpacePage: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    activeView: 'worktree',
    activeWorktreeId: null,
    workspaceSpaceAnalysis: null,
    workspaceSpaceScanning: false,
    runtimePaneTitlesByTabId: {},
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    deferredSshSessionIdsByTabId: {}
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})
vi.mock('@/components/ui/popover', () => ({
  PopoverTrigger: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values
      ? Object.entries(values).reduce(
          (text, [key, value]) => text.replace(`{{${key}}}`, value),
          fallback
        )
      : fallback
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
import { useAppStore } from '@/store'
import { useResourceUsageStatusController } from '@/components/status-bar/use-resource-usage-status-controller'
import { renderResourceUsageStatusTrigger } from '@/components/status-bar/resource-usage-status-trigger'

let spawned: (data: { id: string }) => void
let exited: (data: { id: string; code: number }) => void
const rows: DaemonSession[] = [
  { id: 'native-local', title: 'Local shell', cwd: '/notes', agentOwnership: 'absent' },
  { id: 'ssh-remote', title: 'Remote shell', cwd: 'C:\\notes', agentOwnership: 'present' }
]
const list = vi.fn<() => Promise<DaemonSession[]>>()
beforeEach(() => {
  vi.useFakeTimers()
  list.mockReset().mockResolvedValue(rows)
  vi.stubGlobal('api', {
    pty: {
      listSessions: list,
      onSpawned: (callback: typeof spawned) => {
        spawned = callback
        return vi.fn()
      },
      onExit: (callback: typeof exited) => {
        exited = callback
        return vi.fn()
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('preserves actual badge DOM/controller outputs and no extra reads while avoiding no-op commits', async () => {
  let renders = 0,
    commits = 0
  let current: ReturnType<typeof useResourceUsageStatusController> | undefined
  function Probe() {
    renders += 1
    current = useResourceUsageStatusController()
    return renderResourceUsageStatusTrigger({ ...current, iconOnly: false })
  }
  const view = render(
    createElement(
      Profiler,
      {
        id: 'resource-badge',
        onRender: () => {
          commits += 1
        }
      },
      createElement(Probe)
    )
  )
  await act(async () => {})
  if (!current) {
    throw new Error('actual controller not mounted')
  }
  expect(current.triggerSessionCount).toBe(2)
  expect(current.resourceManagerAriaLabel).toContain('2')
  const initialMarkup = view.container.innerHTML
  const before = renders,
    committed = commits,
    requests = list.mock.calls.length
  for (let index = 0; index < 64; index += 1) {
    act(() => {
      spawned({ id: `short-lived-${index}` })
      exited({ id: `short-lived-${index}`, code: 0 })
    })
    if (!current) {
      throw new Error('actual controller disappeared')
    }
    expect(current.triggerSessionCount).toBe(2)
    expect(current.daemonUnreachable).toBe(false)
    expect(current.unifiedRepos).toEqual([])
    expect(view.container.innerHTML).toBe(initialMarkup)
  }
  const counts = {
    renders: renders - before,
    commits: commits - committed,
    reads: list.mock.calls.length - requests,
    pendingTimers: vi.getTimerCount()
  }
  await act(async () => {
    current?.setOpen(true)
  })
  if (!current) {
    throw new Error('actual open controller missing')
  }
  expect(current.open).toBe(true)
  expect(list).toHaveBeenCalledTimes(requests + 1)
  const snapshotReads = useAppStore.getState().fetchMemorySnapshot
  const readsAtOpen = vi.mocked(snapshotReads).mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_999)
  })
  expect(snapshotReads).toHaveBeenCalledTimes(readsAtOpen)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(snapshotReads).toHaveBeenCalledTimes(readsAtOpen + 1)
  expect(list).toHaveBeenCalledTimes(requests + 1)
  expect(current.triggerSessionCount).toBe(2)
  expect(
    current.unifiedRepos
      .flatMap((group) => group.worktrees)
      .flatMap((worktree) => worktree.sessions)
      .map((session) => session.sessionId)
  ).toEqual(rows.map((row) => row.id))
  const beforeExit = list.mock.calls.length
  act(() => exited({ id: 'ssh-remote', code: 0 }))
  expect(current.triggerSessionCount).toBe(1)
  expect(
    current.unifiedRepos
      .flatMap((group) => group.worktrees)
      .flatMap((worktree) => worktree.sessions)
      .map((session) => session.sessionId)
  ).toEqual(['native-local'])
  expect(list.mock.calls.length).toBe(beforeExit)
  act(() => current?.setOpen(false))
  expect(vi.getTimerCount()).toBe(0)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)

  expect(counts).toEqual({ renders: 1, commits: 1, reads: 0, pendingTimers: 0 })
})
