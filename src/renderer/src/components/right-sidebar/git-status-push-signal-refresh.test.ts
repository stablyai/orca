import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import { ORCA_TERMINAL_COMMAND_FINISHED_EVENT } from '@/hooks/terminal-command-finished-event'

type WorktreesChangedCallback = (data: { repoId: string }) => void
type GitStatusMetadataChangedCallback = (data: { repoId: string }) => void
type HookParams = {
  activeRepoId: string | null
  activeWorktreeId: string | null
  enabled: boolean
  fetchStatus: () => void
}

async function renderHookOnce(params: HookParams): Promise<{
  emitWorktreesChanged: (repoId: string) => void
  emitGitStatusMetadataChanged: (repoId: string) => void
  emitCommandFinished: (worktreeId: string) => void
  onChangedSubscribe: ReturnType<typeof vi.fn>
  onGitStatusMetadataChangedSubscribe: ReturnType<typeof vi.fn>
  onChangedUnsubscribe: ReturnType<typeof vi.fn>
  onGitStatusMetadataChangedUnsubscribe: ReturnType<typeof vi.fn>
  windowListeners: Map<string, EventListener>
  cleanups: (() => void)[]
}> {
  vi.resetModules()

  const cleanups: (() => void)[] = []
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof React>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        const cleanup = effect()
        if (typeof cleanup === 'function') {
          cleanups.push(cleanup)
        }
      },
      useRef: <T>(initial: T) => ({ current: initial })
    }
  })

  let worktreesChangedCallback: WorktreesChangedCallback | null = null
  let gitStatusMetadataChangedCallback: GitStatusMetadataChangedCallback | null = null
  const onChangedUnsubscribe = vi.fn()
  const onGitStatusMetadataChangedUnsubscribe = vi.fn()
  const onChangedSubscribe = vi.fn((callback: WorktreesChangedCallback) => {
    worktreesChangedCallback = callback
    return onChangedUnsubscribe
  })
  const onGitStatusMetadataChangedSubscribe = vi.fn(
    (callback: GitStatusMetadataChangedCallback) => {
      gitStatusMetadataChangedCallback = callback
      return onGitStatusMetadataChangedUnsubscribe
    }
  )
  const windowListeners = new Map<string, EventListener>()

  vi.stubGlobal('window', {
    api: {
      worktrees: {
        onChanged: onChangedSubscribe,
        onGitStatusMetadataChanged: onGitStatusMetadataChangedSubscribe
      }
    },
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      windowListeners.set(type, listener)
    }),
    removeEventListener: vi.fn((type: string) => {
      windowListeners.delete(type)
    })
  })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })

  const { useGitStatusPushSignalRefresh } = await import('./git-status-push-signal-refresh')
  function PushSignalRefreshHarness(props: HookParams): null {
    useGitStatusPushSignalRefresh(props)
    return null
  }
  PushSignalRefreshHarness(params)

  return {
    emitWorktreesChanged: (repoId: string) => worktreesChangedCallback?.({ repoId }),
    emitGitStatusMetadataChanged: (repoId: string) =>
      gitStatusMetadataChangedCallback?.({ repoId }),
    emitCommandFinished: (worktreeId: string) => {
      const listener = windowListeners.get(ORCA_TERMINAL_COMMAND_FINISHED_EVENT)
      listener?.({ detail: { worktreeId } } as unknown as Event)
    },
    onChangedSubscribe,
    onGitStatusMetadataChangedSubscribe,
    onChangedUnsubscribe,
    onGitStatusMetadataChangedUnsubscribe,
    windowListeners,
    cleanups
  }
}

describe('useGitStatusPushSignalRefresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('nudges status when the active repo reports a worktrees change', async () => {
    const fetchStatus = vi.fn()
    const harness = await renderHookOnce({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      enabled: true,
      fetchStatus
    })

    harness.emitWorktreesChanged('repo-1')
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    harness.emitWorktreesChanged('repo-other')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  it('nudges status when the active repo reports git status metadata changes', async () => {
    const fetchStatus = vi.fn()
    const harness = await renderHookOnce({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      enabled: true,
      fetchStatus
    })

    harness.emitGitStatusMetadataChanged('repo-1')
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    harness.emitGitStatusMetadataChanged('repo-other')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  it('nudges status when a terminal command finishes in the active worktree', async () => {
    const fetchStatus = vi.fn()
    const harness = await renderHookOnce({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      enabled: true,
      fetchStatus
    })

    harness.emitCommandFinished('wt-1')
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    harness.emitCommandFinished('wt-other')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  it('drops nudges while the window is hidden', async () => {
    const fetchStatus = vi.fn()
    const harness = await renderHookOnce({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      enabled: true,
      fetchStatus
    })

    ;(document as unknown as { visibilityState: string }).visibilityState = 'hidden'
    harness.emitWorktreesChanged('repo-1')
    harness.emitGitStatusMetadataChanged('repo-1')
    harness.emitCommandFinished('wt-1')
    expect(fetchStatus).not.toHaveBeenCalled()
  })

  it('subscribes to nothing while disabled', async () => {
    const fetchStatus = vi.fn()
    const harness = await renderHookOnce({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      enabled: false,
      fetchStatus
    })

    expect(harness.onChangedSubscribe).not.toHaveBeenCalled()
    expect(harness.onGitStatusMetadataChangedSubscribe).not.toHaveBeenCalled()
    expect(harness.windowListeners.size).toBe(0)
  })

  it('unsubscribes preload and command-finished signals on cleanup', async () => {
    const fetchStatus = vi.fn()
    const harness = await renderHookOnce({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      enabled: true,
      fetchStatus
    })

    expect(harness.cleanups.length).toBe(2)
    for (const cleanup of harness.cleanups) {
      cleanup()
    }
    expect(harness.windowListeners.size).toBe(0)
    expect(harness.onChangedUnsubscribe).toHaveBeenCalledTimes(1)
    expect(harness.onGitStatusMetadataChangedUnsubscribe).toHaveBeenCalledTimes(1)
  })
})
