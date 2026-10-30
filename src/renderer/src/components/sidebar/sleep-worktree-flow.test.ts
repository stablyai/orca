import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => {
  const state: {
    activeWorktreeId: string | null
    activeWorkspaceExecutionHostId?: string | null
    setActiveWorktree: ReturnType<typeof vi.fn>
    shutdownWorktreeBrowsers: ReturnType<typeof vi.fn>
    shutdownWorktreeTerminals: ReturnType<typeof vi.fn>
    tabsByWorktree: Record<string, { id: string }[]>
    ptyIdsByTabId: Record<string, string[]>
    worktreesByRepo: Record<string, { id: string; repoId: string; hostId?: string }[]>
    detectedWorktreesByRepo: Record<string, never>
  } = {
    activeWorktreeId: null,
    setActiveWorktree: vi.fn((worktreeId: string | null) => {
      state.activeWorktreeId = worktreeId
    }),
    shutdownWorktreeBrowsers: vi.fn(),
    shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    worktreesByRepo: {},
    detectedWorktreesByRepo: {}
  }
  const listeners = new Set<(next: typeof state) => void>()
  return {
    listeners,
    clearWorktreeSleepIntent: vi.fn(),
    markWorktreeSleepIntent: vi.fn(),
    state,
    toastError: vi.fn(),
    toastWarning: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: (listener: (next: typeof mocks.state) => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, warning: mocks.toastWarning } }))
vi.mock('@/lib/worktree-sleep-intent', () => ({
  clearWorktreeSleepIntent: mocks.clearWorktreeSleepIntent,
  markWorktreeSleepIntent: mocks.markWorktreeSleepIntent,
  hasWorktreeSleepIntent: () => true,
  withWorktreeSleepTeardown: (_worktreeId: string, teardown: () => Promise<unknown>) => teardown()
}))

import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type {
  WorkspaceSleepOutcome,
  WorkspaceSleepTarget
} from '../../../../shared/workspace-sleep'
import {
  runSleepWorktree,
  runSleepWorktrees,
  sleepWorktreesReportingFailures
} from './sleep-worktree-flow'
import { fakeMainSleep } from './sleep-worktree-test-main'
import { followWorkspaceSleep } from './workspace-sleep-follower'

let main = fakeMainSleep()
const sleepReopened = vi.fn(async () => {})
function answerWith(answer: (target: WorkspaceSleepTarget) => Partial<WorkspaceSleepOutcome>) {
  main = fakeMainSleep(answer)
  vi.stubGlobal('window', {
    api: { worktrees: { sleep: main.sleep, sleepReopened } },
    requestAnimationFrame: vi.fn()
  })
}

const VM_STILL_RUNNING =
  "The workspace's terminals stopped, but its machine couldn't be suspended and is still running."
const HOST_UNCONFIRMED =
  'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'

describe('runSleepWorktree', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    answerWith(() => ({}))
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockReset()
    mocks.state.shutdownWorktreeTerminals
      .mockReset()
      .mockImplementation(
        async (_id: string, opts: Parameters<AppState['shutdownWorktreeTerminals']>[1]) => {
          // Main's answer settles the panes, as the real store does.
          const stop = await opts?.hostStop
          if (stop?.failed) {
            throw new Error('host_terminal_stop_failed')
          }
        }
      )
    mocks.markWorktreeSleepIntent.mockClear()
    mocks.clearWorktreeSleepIntent.mockClear()
    mocks.toastError.mockClear()
    mocks.toastWarning.mockClear()
    mocks.state.activeWorktreeId = null
    mocks.state.activeWorkspaceExecutionHostId = null
    mocks.state.tabsByWorktree = {}
    mocks.state.ptyIdsByTabId = {}
    mocks.state.worktreesByRepo = {}
  })

  it('asks main to sleep the workspace on its own host, chats included', async () => {
    await runSleepWorktree('wt-1')

    expect(main.requests).toEqual([
      {
        targets: [
          { worktreeId: 'wt-1', terminalHost: { kind: 'self' }, chatHosts: [{ kind: 'self' }] }
        ],
        markChatsAsleep: true
      }
    ])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('follows main: hides browsers, then guards the panes main stops, without stopping any itself', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-1', {
      keepIdentifiers: true,
      hostStop: expect.any(Promise)
    })
    const browsersCallOrder = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    const terminalsCallOrder = mocks.state.shutdownWorktreeTerminals.mock.invocationCallOrder[0]
    expect(browsersCallOrder).toBeLessThan(terminalsCallOrder)
  })

  it('marks sleep intent, then clears the active slept worktree, and keeps the intent after', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    const markCall = mocks.markWorktreeSleepIntent.mock.invocationCallOrder[0]
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    const browsersCall = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    expect(markCall).toBeLessThan(activeClear)
    expect(activeClear).toBeLessThan(browsersCall)
    // Why: the marker outlives a successful sleep so mounted panes stay cold until an explicit wake.
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it('preserves active row position through section-scoped sidebar row ids', async () => {
    const requestAnimationFrame = vi.fn(() => 1)
    const scroller = {
      dispatchEvent: vi.fn(),
      scrollHeight: 100,
      scrollTop: 0
    }
    const row = {
      closest: (selector: string) => (selector === '[data-worktree-virtual-row]' ? row : null),
      getBoundingClientRect: () => ({ top: 42 })
    }
    const option = {
      dataset: { worktreeId: 'wt-1' },
      closest: (selector: string) => (selector === '[data-worktree-virtual-row]' ? row : null),
      querySelector: () => null
    }
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector === '[data-worktree-sidebar]' ? scroller : null,
      querySelectorAll: (selector: string) => (selector === '[data-worktree-id]' ? [option] : [])
    })
    vi.stubGlobal('window', { api: { worktrees: { sleep: main.sleep } }, requestAnimationFrame })
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  })

  it('anchors sleep restoration to the natural duplicate row when no primary row is marked', async () => {
    const requestAnimationFrame = vi.fn(() => 1)
    const scroller = {
      dispatchEvent: vi.fn(),
      scrollHeight: 100,
      scrollTop: 0
    }
    const pinnedGetBoundingClientRect = vi.fn(() => ({ top: 10 }))
    const naturalGetBoundingClientRect = vi.fn(() => ({ top: 42 }))
    const pinnedRow = {
      getBoundingClientRect: pinnedGetBoundingClientRect
    }
    const naturalRow = {
      getBoundingClientRect: naturalGetBoundingClientRect
    }
    const pinnedOption = {
      dataset: { worktreeId: 'wt-1', worktreeRowKey: 'pinned:wt-1' },
      closest: (selector: string) =>
        selector === '[data-worktree-virtual-row]' ? pinnedRow : null,
      querySelector: () => null
    }
    const naturalOption = {
      dataset: { worktreeId: 'wt-1', worktreeRowKey: 'all:wt-1' },
      closest: (selector: string) =>
        selector === '[data-worktree-virtual-row]' ? naturalRow : null,
      querySelector: () => null
    }
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector === '[data-worktree-sidebar]' ? scroller : null,
      querySelectorAll: (selector: string) =>
        selector === '[data-worktree-id]' ? [pinnedOption, naturalOption] : []
    })
    vi.stubGlobal('window', { api: { worktrees: { sleep: main.sleep } }, requestAnimationFrame })
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(naturalGetBoundingClientRect).toHaveBeenCalled()
    expect(pinnedGetBoundingClientRect).not.toHaveBeenCalled()
  })

  it('leaves activeWorktreeId alone and marks a background worktree slept', async () => {
    mocks.state.activeWorktreeId = 'wt-other'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it('restores the active workspace and shows the host copy when main could not confirm', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    answerWith(() => ({ failure: 'terminal_liveness_unavailable' }))

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree.mock.calls).toEqual([[null], ['wt-1']])
    expect(mocks.clearWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({ description: HOST_UNCONFIRMED })
    )
  })

  it('restores the active twin on the host it was selected on', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.activeWorkspaceExecutionHostId = 'ssh:box'
    answerWith(() => ({ failure: 'terminal_worktree_sleep_still_live' }))

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).toHaveBeenLastCalledWith('wt-1', 'ssh:box')
  })

  it('leaves a workspace the user picked during a failed sleep selected', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    answerWith(() => {
      mocks.state.activeWorktreeId = 'wt-picked'
      return { failure: 'terminal_worktree_sleep_still_live' }
    })

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree.mock.calls).toEqual([[null]])
    expect(mocks.state.activeWorktreeId).toBe('wt-picked')
  })

  it('reports one failed workspace of a batch and leaves the others asleep', async () => {
    answerWith((target) => (target.worktreeId === 'wt-1' ? { failure: 'boom' } : {}))

    await runSleepWorktrees(['wt-1', 'wt-2'])

    expect(mocks.clearWorktreeSleepIntent.mock.calls).toEqual([['wt-1']])
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep some workspaces',
      expect.objectContaining({
        description:
          'The workspace was kept open. Try again; if the problem continues, check the host connection.'
      })
    )
  })

  it('reports failed worktrees to a caller that answers for them, without a toast', async () => {
    answerWith((target) => (target.worktreeId === 'wt-1' ? { failure: 'boom' } : {}))

    const outcome = await sleepWorktreesReportingFailures(['wt-1', 'wt-2'])

    expect(outcome.failedWorktreeIds).toEqual(['wt-1'])
    expect(outcome.errors).toHaveLength(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
    // A project move pauses through this core; only the user's Sleep asks hosts to mark chats.
    expect(main.requests[0]?.markChatsAsleep).toBe(false)
  })

  it('clears the active workspace only once when a batch includes it', async () => {
    mocks.state.activeWorktreeId = 'wt-2'

    await runSleepWorktrees(['wt-1', 'wt-2'])

    expect(mocks.state.setActiveWorktree.mock.calls).toEqual([[null]])
    expect(mocks.state.shutdownWorktreeBrowsers.mock.calls).toEqual([['wt-1'], ['wt-2']])
  })

  const twinId = 'repo-1::/wt'
  const twinRows = {
    'repo-1': [
      { id: twinId, repoId: 'repo-1', hostId: 'local' },
      { id: twinId, repoId: 'repo-1', hostId: 'runtime:env-a' }
    ]
  }

  it('names every host that publishes a copy for its chats, and the copy that runs its terminals', async () => {
    mocks.state.worktreesByRepo = twinRows
    mocks.state.tabsByWorktree = { [twinId]: [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': [toRemoteRuntimePtyId('pty-1', 'env-a')] }
    answerWith(() => ({
      receipts: [
        { executionHostId: 'local', stoppedSessionIds: ['chat-local'] },
        { executionHostId: 'runtime:env-a', stoppedSessionIds: ['chat-env'] }
      ]
    }))

    const results = await runSleepWorktrees([twinId])

    expect(main.requests[0]?.targets).toEqual([
      {
        worktreeId: twinId,
        terminalHost: { kind: 'environment', environmentId: 'env-a' },
        chatHosts: [{ kind: 'self' }, { kind: 'environment', environmentId: 'env-a' }]
      }
    ])
    expect(results).toEqual([
      expect.objectContaining({ executionHostId: 'local', stoppedSessionIds: ['chat-local'] }),
      expect.objectContaining({ executionHostId: 'runtime:env-a', completed: true })
    ])
  })

  it('asks nothing when it cannot tell which copy runs the terminals', async () => {
    mocks.state.worktreesByRepo = twinRows

    await runSleepWorktree(twinId)

    expect(main.requests).toEqual([])
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({
        description:
          "Orca couldn't tell which host runs this workspace's terminals, so the workspace was kept open. Reconnect its hosts and try again."
      })
    )
  })

  it('reports an unconfirmed chat stop in one toast and keeps stopped terminals asleep', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    answerWith(() => ({ chatFailed: true }))

    const results = await runSleepWorktree('wt-1')

    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
    expect(mocks.state.setActiveWorktree.mock.calls).toEqual([[null]])
    expect(results).toEqual([])
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to sleep workspace', {
      description:
        'The host could not confirm the chat stopped. Other panels may have closed; check the connection and try again.'
    })
  })

  it('sleeps a workspace named by both copies of a twin once', async () => {
    await runSleepWorktrees(['wt-1', 'wt-1'])

    expect(main.requests[0]?.targets).toHaveLength(1)
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledTimes(1)
  })

  it('tells main when the user opens the workspace before its sleep ends', async () => {
    sleepReopened.mockClear()
    followWorkspaceSleep({ worktreeId: 'wt-1', phase: 'started' })
    // The user picks the workspace while main still runs its sleep.
    mocks.state.activeWorktreeId = 'wt-1'
    for (const listener of mocks.listeners) {
      listener(mocks.state)
    }
    followWorkspaceSleep({
      worktreeId: 'wt-1',
      phase: 'ended',
      slept: true,
      stoppedPtyIds: [],
      records: null
    })
    await Promise.resolve()
    expect(sleepReopened).toHaveBeenCalledWith('wt-1')
    expect(mocks.listeners.size).toBe(0)
  })

  it("shows a phone's failed sleep with the copy of the window's own Sleep", () => {
    followWorkspaceSleep({
      worktreeId: 'wt-1',
      phase: 'failed',
      outcome: {
        worktreeId: 'wt-1',
        failure: 'terminal_liveness_unavailable',
        chatFailed: false,
        receipts: []
      }
    })
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({ description: HOST_UNCONFIRMED })
    )
  })

  it('says the machine still runs, not "kept open", when only the VM would not suspend', async () => {
    answerWith(() => ({ vmSuspendFailure: 'vm busy' }))
    await runSleepWorktree('wt-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledWith(VM_STILL_RUNNING)
    // The workspace slept: nothing rolls it back.
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it("shows a phone's sleep whose VM would not suspend with the same copy", () => {
    followWorkspaceSleep({
      worktreeId: 'wt-1',
      phase: 'failed',
      outcome: { worktreeId: 'wt-1', vmSuspendFailure: 'vm busy', chatFailed: false, receipts: [] }
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledWith(VM_STILL_RUNNING)
  })
})
