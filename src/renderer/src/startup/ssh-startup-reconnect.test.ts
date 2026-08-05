import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from '../../../shared/ssh-types'
import {
  partitionSshStartupReconnectTargets,
  reconnectSshTargetsForRendererStartup,
  resolveSshStartupActiveWorkspaceId,
  shouldStartBackgroundSshReconnect,
  SshStartupReconnectScheduler
} from './ssh-startup-reconnect'

const connectedState: SshConnectionState = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0,
  providerEpoch: 'startup-provider-epoch' as SshProviderEpoch,
  connectionGeneration: 41,
  remotePlatform: 'linux'
}

function stateFor(targetId: string): SshConnectionState {
  return { ...connectedState, targetId }
}

function controlledPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('partitionSshStartupReconnectTargets', () => {
  it('unwraps an active worktree key before connection-owner resolution', () => {
    expect(
      resolveSshStartupActiveWorkspaceId({
        activeWorkspaceKey: 'worktree:repo-1::/remote/project',
        activeWorktreeId: 'stale-worktree'
      })
    ).toBe('repo-1::/remote/project')
    expect(
      resolveSshStartupActiveWorkspaceId({
        activeWorkspaceKey: 'folder:folder-1',
        activeWorktreeId: null
      })
    ).toBe('folder:folder-1')
  })

  it('prioritizes active targets, then persisted sessions, in stable target order', () => {
    expect(
      partitionSshStartupReconnectTargets({
        targetIds: ['idle-a', 'session-b', 'active-c', 'session-d', 'active-c'],
        activeTargetIds: ['active-c', 'missing'],
        activeTabId: 'tab-active',
        remoteSessionIdsByTabId: {
          'tab-other': 'ssh:session-b@@pty-1',
          'tab-active': 'ssh:session-d@@pty-2',
          malformed: 'relay-pty-without-target',
          stale: 'ssh:missing@@pty-3'
        }
      })
    ).toEqual({
      criticalTargetIds: ['active-c', 'session-d'],
      backgroundTargetIds: ['session-b', 'idle-a']
    })
  })

  it("elevates the active workspace's own tabs when owner resolution found no connection", () => {
    // Owner resolution returns undefined for a repo missing from the local catalog, so
    // activeTargetIds is empty; the workspace's non-focused tabs must still be critical.
    expect(
      partitionSshStartupReconnectTargets({
        targetIds: ['idle-a', 'workspace-b'],
        activeTargetIds: [],
        activeTabId: 'tab-editor',
        activeWorkspaceSessionIds: ['ssh:workspace-b@@pty-1'],
        remoteSessionIdsByTabId: {
          'tab-terminal': 'ssh:workspace-b@@pty-1',
          'tab-elsewhere': 'ssh:idle-a@@pty-2'
        }
      })
    ).toEqual({
      criticalTargetIds: ['workspace-b'],
      backgroundTargetIds: ['idle-a']
    })
  })

  // Why: remoteSessionIdsByTabId is built from repo → connectionId, which folder workspaces have
  // no path to. Their tabs' own pty ids are the only record of the host, so elevation has to run
  // off those or every folder-workspace SSH host lands in the background batch.
  it('elevates a folder workspace host that no repo mapping can name', () => {
    expect(
      partitionSshStartupReconnectTargets({
        targetIds: ['idle-a', 'folder-host'],
        activeTargetIds: [],
        activeTabId: null,
        activeWorkspaceSessionIds: ['ssh:folder-host@@pty-9', 'local-pty-no-target'],
        remoteSessionIdsByTabId: { 'tab-elsewhere': 'ssh:idle-a@@pty-2' }
      })
    ).toEqual({
      criticalTargetIds: ['folder-host'],
      backgroundTargetIds: ['idle-a']
    })
  })
})

describe('reconnectSshTargetsForRendererStartup', () => {
  it('reconnects a healthy background target after a critical target fails', async () => {
    const scheduler = new SshStartupReconnectScheduler(1)
    const starts: string[] = []
    const connect = async (targetId: string): Promise<SshConnectionState> => {
      starts.push(targetId)
      if (targetId === 'ssh-critical') {
        throw new Error('Authentication failed')
      }
      return stateFor(targetId)
    }
    const reconnect = (targetIds: readonly string[]) =>
      reconnectSshTargetsForRendererStartup({
        targetIds,
        attemptTimeoutMs: 1_000,
        batchBudgetMs: 1_000,
        signal: new AbortController().signal,
        scheduler,
        connect,
        publishState: vi.fn(),
        onFailure: vi.fn()
      })

    const criticalResults = await reconnect(['ssh-critical'])
    expect(criticalResults).toEqual([{ targetId: 'ssh-critical', outcome: 'failed' }])
    expect(
      shouldStartBackgroundSshReconnect({
        backgroundTargetCount: 1,
        aborted: false
      })
    ).toBe(true)
    await expect(reconnect(['ssh-background'])).resolves.toEqual([
      { targetId: 'ssh-background', outcome: 'completed' }
    ])
    expect(starts).toEqual(['ssh-critical', 'ssh-background'])
  })

  it('bounds raw concurrent attempts and starts queued targets as slots settle', async () => {
    const scheduler = new SshStartupReconnectScheduler(2)
    const controls = new Map<string, ReturnType<typeof controlledPromise<SshConnectionState>>>()
    let active = 0
    let peak = 0
    const starts: string[] = []
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-1', 'ssh-2', 'ssh-3', 'ssh-4'],
      attemptTimeoutMs: 5_000,
      signal: new AbortController().signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        active++
        peak = Math.max(peak, active)
        const control = controlledPromise<SshConnectionState>()
        controls.set(targetId, control)
        return control.promise.finally(() => {
          active--
        })
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.waitFor(() => expect(starts).toEqual(['ssh-1', 'ssh-2']))
    controls.get('ssh-1')!.resolve(stateFor('ssh-1'))
    await vi.waitFor(() => expect(starts).toEqual(['ssh-1', 'ssh-2', 'ssh-3']))
    controls.get('ssh-2')!.resolve(stateFor('ssh-2'))
    await vi.waitFor(() => expect(starts).toEqual(['ssh-1', 'ssh-2', 'ssh-3', 'ssh-4']))
    controls.get('ssh-3')!.resolve(stateFor('ssh-3'))
    controls.get('ssh-4')!.resolve(stateFor('ssh-4'))

    await expect(resultPromise).resolves.toEqual(
      ['ssh-1', 'ssh-2', 'ssh-3', 'ssh-4'].map((targetId) => ({
        targetId,
        outcome: 'completed'
      }))
    )
    expect(peak).toBe(2)
  })

  it('bounds a budgeted batch end to end, dropping targets still queued at expiry', async () => {
    vi.useFakeTimers()
    const starts: string[] = []
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-stalled', 'ssh-queued'],
      attemptTimeoutMs: 1_000,
      batchBudgetMs: 1_000,
      signal: new AbortController().signal,
      scheduler: new SshStartupReconnectScheduler(1),
      connect: (targetId) => {
        starts.push(targetId)
        return new Promise(() => {})
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toEqual([
      { targetId: 'ssh-stalled', outcome: 'timed-out' },
      { targetId: 'ssh-queued', outcome: 'not-started-budget' }
    ])
    expect(starts).toEqual(['ssh-stalled'])
  })

  it('gives every unbudgeted target its own attempt behind slow front-of-queue hosts', async () => {
    vi.useFakeTimers()
    const scheduler = new SshStartupReconnectScheduler(1)
    const starts: string[] = []
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-slow-1', 'ssh-slow-2', 'ssh-tail'],
      attemptTimeoutMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        return targetId === 'ssh-tail'
          ? Promise.resolve(stateFor(targetId))
          : new Promise<SshConnectionState>(() => {})
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    // Two full attempt timeouts elapse before the tail host ever reaches a slot.
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(resultPromise).resolves.toEqual([
      { targetId: 'ssh-slow-1', outcome: 'timed-out' },
      { targetId: 'ssh-slow-2', outcome: 'timed-out' },
      { targetId: 'ssh-tail', outcome: 'completed' }
    ])
    expect(starts).toEqual(['ssh-slow-1', 'ssh-slow-2', 'ssh-tail'])
  })

  it('clamps a late-started attempt to what is left of the batch budget', async () => {
    vi.useFakeTimers()
    const scheduler = new SshStartupReconnectScheduler(1)
    const starts: string[] = []
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-slow', 'ssh-late'],
      attemptTimeoutMs: 600,
      batchBudgetMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        return new Promise<SshConnectionState>(() => {})
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    // ssh-slow burns 600ms, so ssh-late gets the remaining 400ms — not a fresh 600ms, which
    // would push the awaited critical batch out to 1_200ms.
    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toEqual(['ssh-slow', 'ssh-late'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(resultPromise).resolves.toEqual([
      { targetId: 'ssh-slow', outcome: 'timed-out' },
      { targetId: 'ssh-late', outcome: 'timed-out' }
    ])
  })

  // Why: without a floor, a target reaching a slot with a sliver of budget left dials main, is
  // killed milliseconds later, and reports 'timed-out' with an onFailure warning — a connect that
  // never had a chance, indistinguishable from a real host failure.
  it('skips an attempt whose remaining batch budget is below the useful floor', async () => {
    vi.useFakeTimers()
    const starts: string[] = []
    const onFailure = vi.fn()
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-slow', 'ssh-sliver'],
      attemptTimeoutMs: 900,
      batchBudgetMs: 1_000,
      signal: new AbortController().signal,
      scheduler: new SshStartupReconnectScheduler(1),
      connect: (targetId) => {
        starts.push(targetId)
        return new Promise<SshConnectionState>(() => {})
      },
      publishState: vi.fn(),
      onFailure
    })

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toEqual([
      { targetId: 'ssh-slow', outcome: 'timed-out' },
      { targetId: 'ssh-sliver', outcome: 'not-started-budget' }
    ])
    // ssh-sliver gives up waiting once the batch has less than the floor left, so it never dials.
    expect(starts).toEqual(['ssh-slow'])
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledWith('ssh-slow', expect.any(Error))
  })

  it("frees a hung target's slot at its deadline so later batches still run", async () => {
    vi.useFakeTimers()
    const scheduler = new SshStartupReconnectScheduler(1)
    const starts: string[] = []
    const hungResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-hung'],
      attemptTimeoutMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        return new Promise<SshConnectionState>(() => {})
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(hungResult).resolves.toEqual([{ targetId: 'ssh-hung', outcome: 'timed-out' }])

    const nextResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-next'],
      attemptTimeoutMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: async (targetId) => {
        starts.push(targetId)
        return stateFor(targetId)
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(0)
    await expect(nextResult).resolves.toEqual([{ targetId: 'ssh-next', outcome: 'completed' }])
    expect(starts).toEqual(['ssh-hung', 'ssh-next'])
  })

  it('cancels queued results and suppresses late state publication', async () => {
    const scheduler = new SshStartupReconnectScheduler(1)
    const abortController = new AbortController()
    const first = controlledPromise<SshConnectionState>()
    const starts: string[] = []
    const publishState = vi.fn()
    const onFailure = vi.fn()
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-started', 'ssh-queued'],
      attemptTimeoutMs: 1_000,
      signal: abortController.signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        return first.promise
      },
      publishState,
      onFailure
    })

    await vi.waitFor(() => expect(starts).toEqual(['ssh-started']))
    abortController.abort()
    await expect(resultPromise).resolves.toEqual([
      { targetId: 'ssh-started', outcome: 'cancelled' },
      { targetId: 'ssh-queued', outcome: 'cancelled' }
    ])

    first.resolve(stateFor('ssh-started'))
    await first.promise
    await Promise.resolve()
    expect(starts).toEqual(['ssh-started'])
    expect(publishState).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('frees the slot immediately when main already owns the connect', async () => {
    vi.useFakeTimers()
    const scheduler = new SshStartupReconnectScheduler(1)
    const starts: string[] = []
    const results = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-duplicate', 'ssh-behind'],
      attemptTimeoutMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: async (targetId) => {
        starts.push(targetId)
        if (targetId === 'ssh-duplicate') {
          throw new Error('Connection to duplicate host is already in progress')
        }
        return stateFor(targetId)
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    // No timer advance: main owns the duplicate's attempt, so the queue must not wait out a timeout.
    await expect(results).resolves.toEqual([
      { targetId: 'ssh-duplicate', outcome: 'in-progress' },
      { targetId: 'ssh-behind', outcome: 'completed' }
    ])
    expect(starts).toEqual(['ssh-duplicate', 'ssh-behind'])
  })

  it('keeps an aborted raw attempt in the pool until its connect promise settles', async () => {
    const scheduler = new SshStartupReconnectScheduler(1)
    const firstAbort = new AbortController()
    const first = controlledPromise<SshConnectionState>()
    const starts: string[] = []
    const firstResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-old'],
      attemptTimeoutMs: 1_000,
      signal: firstAbort.signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        return first.promise
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.waitFor(() => expect(starts).toEqual(['ssh-old']))
    firstAbort.abort()
    await expect(firstResult).resolves.toEqual([{ targetId: 'ssh-old', outcome: 'cancelled' }])

    const nextResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-new'],
      attemptTimeoutMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: async (targetId) => {
        starts.push(targetId)
        return stateFor(targetId)
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })
    await Promise.resolve()
    expect(starts).toEqual(['ssh-old'])

    first.resolve(stateFor('ssh-old'))
    await expect(nextResult).resolves.toEqual([{ targetId: 'ssh-new', outcome: 'completed' }])
    expect(starts).toEqual(['ssh-old', 'ssh-new'])
  })
})

describe('shouldStartBackgroundSshReconnect', () => {
  it('requires a background target and a live startup signal', () => {
    expect(
      shouldStartBackgroundSshReconnect({
        backgroundTargetCount: 0,
        aborted: false
      })
    ).toBe(false)
    expect(
      shouldStartBackgroundSshReconnect({
        backgroundTargetCount: 1,
        aborted: true
      })
    ).toBe(false)
    expect(
      shouldStartBackgroundSshReconnect({
        backgroundTargetCount: 1,
        aborted: false
      })
    ).toBe(true)
  })
})
