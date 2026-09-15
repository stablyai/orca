import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  recoverWorkspaceActivation,
  type WorkspaceActivationIdentity
} from './worktree-activation-recovery'
import {
  readWorkspaceActivationRecoveryPresentation,
  resetWorkspaceActivationRecoveryPresentationsForTests
} from './workspace-activation-recovery-presentation'
import {
  discardWorkspaceSurfaceProducerAttempt,
  readWorkspaceSurfaceProducerEntries,
  registerWorkspaceSurfaceProducer,
  resetWorkspaceSurfaceProducersForTests
} from './workspace-surface-production'
import { isActivationExecutionRouteCurrent } from './workspace-activation-recovery-state'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import * as activationProducer from './workspace-activation-surface-producer'

type FakeUnifiedTab = {
  id: string
  contentType:
    | 'terminal'
    | 'editor'
    | 'diff'
    | 'conflict-review'
    | 'check-details'
    | 'agent-session'
    | 'browser'
    | 'simulator'
}

const mocks = vi.hoisted(() => {
  const storeListeners = new Set<() => void>()
  const structuredListeners = new Set<() => void>()
  let tabSequence = 0
  let uuidSequence = 0
  let reconcileHook: (() => void) | null = null
  let currentState: {
    activeWorktreeId: string
    activeWorkspaceExecutionHostId: string
    executionHostId: string
    runtimeEnvironmentId: string | null
    sleepingAgentSessionsByPaneKey: Record<string, { worktreeId: string }>
    tabsByWorktree: Record<string, unknown[]>
    unifiedTabsByWorktree: Record<string, FakeUnifiedTab[]>
    remoteWorkspaceHydratedTargetIds: Set<string>
    remoteWorkspaceSyncStatusByTargetId: Record<string, { phase: 'offline' | 'synced' }>
    reconcileWorktreeTabModel: (workspaceKey: string) => {
      renderableTabCount: number
      activeRenderableTabId: string | null
    }
    createTab: ReturnType<typeof vi.fn>
  }
  const reconcileWorktreeTabModel = (workspaceKey: string) => {
    const hook = reconcileHook
    reconcileHook = null
    hook?.()
    const tabs = currentState.unifiedTabsByWorktree[workspaceKey] ?? []
    return {
      renderableTabCount: tabs.length,
      activeRenderableTabId: tabs[0]?.id ?? null
    }
  }
  const createTab = vi.fn((workspaceKey: string) => {
    const id = `recovery-tab-${++tabSequence}`
    const tab = { id, contentType: 'terminal' as const }
    currentState.tabsByWorktree[workspaceKey] = [tab]
    currentState.unifiedTabsByWorktree[workspaceKey] = [tab]
    for (const listener of storeListeners) {
      listener()
    }
    return tab
  })
  const freshState = () => ({
    activeWorktreeId: 'worktree-1',
    activeWorkspaceExecutionHostId: 'local',
    executionHostId: 'local',
    runtimeEnvironmentId: null,
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    remoteWorkspaceHydratedTargetIds: new Set<string>(),
    remoteWorkspaceSyncStatusByTargetId: {},
    reconcileWorktreeTabModel,
    createTab
  })
  currentState = freshState()
  return {
    state: () => currentState,
    reset: () => {
      tabSequence = 0
      uuidSequence = 0
      reconcileHook = null
      createTab.mockReset()
      createTab.mockImplementation((workspaceKey: string) => {
        const id = `recovery-tab-${++tabSequence}`
        const tab = { id, contentType: 'terminal' as const }
        currentState.tabsByWorktree[workspaceKey] = [tab]
        currentState.unifiedTabsByWorktree[workspaceKey] = [tab]
        for (const listener of storeListeners) {
          listener()
        }
        return tab
      })
      currentState = freshState()
    },
    notifyStore: () => {
      for (const listener of storeListeners) {
        listener()
      }
    },
    runOnNextReconcile: (hook: () => void) => {
      reconcileHook = hook
    },
    subscribeStore: (listener: () => void) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
    authority: vi.fn(() => 'none'),
    structuredStatus: vi.fn(() => 'idle'),
    subscribeStructured: (listener: () => void) => {
      structuredListeners.add(listener)
      return () => structuredListeners.delete(listener)
    },
    nextUuid: () => `recovery-attempt-${++uuidSequence}`
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: mocks.state,
    subscribe: mocks.subscribeStore
  }
}))
vi.mock('@/components/terminal/initial-terminal', () => ({
  shouldAutoCreateInitialTerminal: (count: number) => count === 0
}))
vi.mock('./workspace-terminal-host-authority', () => ({
  resolveWorkspaceTerminalHostAuthority: mocks.authority
}))
vi.mock('./worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mocks.state().executionHostId,
  getRuntimeEnvironmentIdForWorktree: () => mocks.state().runtimeEnvironmentId
}))
vi.mock('./structured-agent-session-launch-status', () => ({
  getStructuredAgentLaunchStatus: mocks.structuredStatus,
  subscribeStructuredAgentLaunchStatus: mocks.subscribeStructured
}))
vi.mock('./browser-uuid', () => ({ createBrowserUuid: mocks.nextUuid }))

const WORKSPACE_KEY = 'worktree-1'

function identity(
  attemptId: string,
  overrides: Partial<WorkspaceActivationIdentity> = {}
): WorkspaceActivationIdentity {
  return {
    workspaceKey: WORKSPACE_KEY,
    executionHostId: 'local',
    runtimeEnvironmentId: null,
    attemptId,
    ...overrides
  }
}

function showSurface(contentType: FakeUnifiedTab['contentType'], id = 'surface-1'): void {
  mocks.state().unifiedTabsByWorktree[mocks.state().activeWorktreeId] = [{ id, contentType }]
  mocks.notifyStore()
}

beforeEach(() => {
  mocks.reset()
  mocks.authority.mockReset()
  mocks.authority.mockReturnValue('none')
  mocks.structuredStatus.mockReset()
  mocks.structuredStatus.mockReturnValue('idle')
  replaceRuntimeEnvironmentRevisions([])
  resetWorkspaceSurfaceProducersForTests()
  resetWorkspaceActivationRecoveryPresentationsForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('activation recovery failures', () => {
  it('invalidates a captured route when the saved runtime is re-paired', () => {
    mocks.state().activeWorkspaceExecutionHostId = 'runtime:environment-1'
    mocks.state().executionHostId = 'runtime:environment-1'
    mocks.state().runtimeEnvironmentId = 'environment-1'
    replaceRuntimeEnvironmentRevisions([{ id: 'environment-1', createdAt: 1, pairingRevision: 17 }])
    const route = {
      ...identity('paired-runtime-attempt', {
        executionHostId: 'runtime:environment-1',
        runtimeEnvironmentId: 'environment-1'
      }),
      runtimeEnvironmentRevision: 17
    }

    expect(isActivationExecutionRouteCurrent({ ...route, runtimeEnvironmentRevision: null })).toBe(
      false
    )
    expect(isActivationExecutionRouteCurrent(route)).toBe(true)
    replaceRuntimeEnvironmentRevisions([{ id: 'environment-1', createdAt: 1, pairingRevision: 18 }])
    expect(isActivationExecutionRouteCurrent(route)).toBe(false)
  })

  it('publishes a blocked error and starts no writer', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'blocked-producer'
    })
    producer.blocked('host ownership is incomplete')

    const result = await recoverWorkspaceActivation(identity('blocked-attempt'), {
      mode: 'explicit'
    })

    expect(result).toMatchObject({ kind: 'failed', reason: 'blocked' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')?.kind).toBe(
      'blocked'
    )
  })

  it('contains an observer reconciliation rejection as an unexpected error', async () => {
    mocks.state().reconcileWorktreeTabModel = vi.fn(() => {
      throw new Error('inventory reconciliation failed')
    })

    const result = await recoverWorkspaceActivation(identity('rejected-attempt'), {
      mode: 'explicit'
    })

    expect(result).toMatchObject({ kind: 'failed', reason: 'unexpected' })
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')).toMatchObject({
      kind: 'unexpected',
      detail: 'inventory reconciliation failed'
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('does not seed when no concrete producer owns an empty activation', async () => {
    const result = await recoverWorkspaceActivation(identity('observer-only-attempt'), {
      mode: 'explicit'
    })

    expect(result).toMatchObject({ kind: 'failed', reason: 'unexpected' })
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')).toMatchObject({
      kind: 'unexpected',
      detail: 'No concrete surface producer owns this empty workspace activation.'
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('keeps a failed concrete producer visible without substituting a shell', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'producer-failure'
    })
    producer.failed('agent executable was not found')

    const result = await recoverWorkspaceActivation(identity('failed-producer-attempt'), {
      mode: 'explicit'
    })

    expect(result).toMatchObject({ kind: 'failed', reason: 'producer-failed' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')).toMatchObject({
      kind: 'producer-failed',
      detail: 'agent executable was not found'
    })
  })

  it('does not let a surviving unrelated surface hide a producer failure', async () => {
    showSurface('terminal', 'setup-tab')
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'failed-agent-producer'
    })
    producer.failed('The requested agent did not start.')

    const result = await recoverWorkspaceActivation(identity('failed-agent-attempt'), {
      mode: 'explicit'
    })

    expect(result).toMatchObject({ kind: 'failed', reason: 'producer-failed' })
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')).toMatchObject({
      kind: 'producer-failed',
      detail: 'The requested agent did not start.'
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('clears a producer failure when Retry observes the requested surface', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'retry-producer'
    })
    producer.failed('agent executable was not found')
    await recoverWorkspaceActivation(identity('retry-failure'), { mode: 'explicit' })
    const failure = readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')
    expect(failure?.kind).toBe('producer-failed')

    showSurface('agent-session', 'published-after-retry')
    failure?.retry()

    await vi.waitFor(() =>
      expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')).toBeNull()
    )
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('retains unverifiable producer ownership after cancellation', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'unknown-producer'
    })
    producer.unverifiable('dispatch acceptance is unknown')

    const result = await recoverWorkspaceActivation(identity('unknown-attempt'), {
      mode: 'explicit'
    })

    expect(result).toMatchObject({
      kind: 'deferred',
      ownerAttemptId: 'unknown-producer'
    })
    expect(readWorkspaceSurfaceProducerEntries(identity('unused'))).toHaveLength(1)
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('retries a declined producer through a new concrete attempt', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'declined-producer'
    })
    producer.declined('Browser publication was refused by the host.')

    await expect(
      recoverWorkspaceActivation(identity('declined-attempt'), { mode: 'explicit' })
    ).resolves.toMatchObject({ kind: 'failed', reason: 'producer-failed' })
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')).toMatchObject({
      kind: 'producer-failed',
      detail: 'Browser publication was refused by the host.'
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()

    const start = vi
      .spyOn(activationProducer, 'startWorkspaceActivationSurfaceProducer')
      .mockImplementation((retryIdentity) => {
        discardWorkspaceSurfaceProducerAttempt(producer.attempt.id)
        const retried = registerWorkspaceSurfaceProducer(retryIdentity)
        retried.failed('The retry reached the host and failed.')
        return null
      })
    readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')?.retry()
    await vi.waitFor(() =>
      expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')?.detail).toBe(
        'The retry reached the host and failed.'
      )
    )
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceKey: WORKSPACE_KEY, executionHostId: 'local' }),
      { mode: 'explicit', supersedeSettledOwnership: true }
    )
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('bounds an inventory assessment and publishes an actionable timeout', async () => {
    vi.useFakeTimers()
    registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'pending-producer'
    })

    const recovery = recoverWorkspaceActivation(identity('deadline-attempt'), {
      mode: 'explicit'
    })
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(recovery).resolves.toMatchObject({
      kind: 'deferred',
      ownerAttemptId: 'pending-producer'
    })
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, 'local')?.kind).toBe(
      'unverifiable'
    )
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('accepts a later producer update after an unverifiable settlement', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'updated-producer'
    })
    producer.unverifiable('publication acknowledgement was lost')

    await expect(
      recoverWorkspaceActivation(identity('unverifiable-observation'), { mode: 'explicit' })
    ).resolves.toMatchObject({ kind: 'deferred', ownerAttemptId: 'updated-producer' })

    producer.materialized({ kind: 'tab', id: 'published-later' })
    const recovery = recoverWorkspaceActivation(identity('updated-observation'), {
      mode: 'explicit'
    })
    showSurface('agent-session', 'published-later')

    await expect(recovery).resolves.toEqual({
      kind: 'materialized',
      surface: { id: 'published-later', type: 'agent-session' }
    })
    expect(readWorkspaceSurfaceProducerEntries(identity('unused'))).toEqual([])
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('reconciles visible inventory over an unverifiable producer verdict', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'reconciled-producer'
    })
    producer.unverifiable('publication acknowledgement was lost')
    showSurface('browser', 'visible-after-uncertainty')

    await expect(
      recoverWorkspaceActivation(identity('reconciled-observation'), { mode: 'explicit' })
    ).resolves.toEqual({
      kind: 'materialized',
      surface: { id: 'visible-after-uncertainty', type: 'browser' }
    })
    expect(readWorkspaceSurfaceProducerEntries(identity('unused'))).toEqual([])
  })
})

describe('activation recovery settlement', () => {
  it('uses the live startup tombstone during observation', async () => {
    mocks.state().tabsByWorktree[WORKSPACE_KEY] = []

    await expect(
      recoverWorkspaceActivation(identity('startup-tombstone'), { mode: 'startup' })
    ).resolves.toEqual({ kind: 'intentional-empty' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('does not let the observer override a live tombstone with a writer', async () => {
    mocks.state().tabsByWorktree[WORKSPACE_KEY] = []

    await expect(
      recoverWorkspaceActivation(identity('explicit-tombstone'), { mode: 'explicit' })
    ).resolves.toMatchObject({ kind: 'failed', reason: 'unexpected' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it.each([
    ['terminal', 'terminal'],
    ['diff', 'editor'],
    ['agent-session', 'agent-session'],
    ['browser', 'browser'],
    ['simulator', 'simulator']
  ] as const)(
    'accepts a surviving %s surface without a fallback',
    async (contentType, visibleType) => {
      showSurface(contentType)

      const result = await recoverWorkspaceActivation(identity(`surface-${contentType}`), {
        mode: 'explicit'
      })

      expect(result).toMatchObject({
        kind: 'materialized',
        surface: { id: 'surface-1', type: visibleType }
      })
      expect(mocks.state().createTab).not.toHaveBeenCalled()
    }
  )

  it('cancels one startup request without consuming a later assessment', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'startup-producer'
    })
    const abort = new AbortController()
    const first = recoverWorkspaceActivation(identity('cancelled-startup'), {
      mode: 'startup',
      signal: abort.signal
    })
    await Promise.resolve()
    abort.abort()
    await expect(first).resolves.toEqual({ kind: 'stale' })
    producer.intentionalEmpty()

    await expect(
      recoverWorkspaceActivation(identity('replacement-startup'), { mode: 'startup' })
    ).resolves.toEqual({ kind: 'intentional-empty' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('invalidates an old request across an away-and-back selection cycle', async () => {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'selection-producer'
    })
    const first = recoverWorkspaceActivation(identity('before-away-and-back'), {
      mode: 'explicit'
    })
    await Promise.resolve()

    mocks.state().activeWorktreeId = 'worktree-2'
    mocks.notifyStore()
    mocks.state().activeWorktreeId = WORKSPACE_KEY
    mocks.notifyStore()

    await expect(first).resolves.toEqual({ kind: 'stale' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
    producer.materialized({ kind: 'workspace-content', id: 'new-selection-content' })

    await expect(
      recoverWorkspaceActivation(identity('after-away-and-back'), { mode: 'explicit' })
    ).resolves.toEqual({
      kind: 'materialized',
      surface: { id: 'new-selection-content', type: 'workspace-content' }
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('invalidates an observer whose captured host tuple changes', async () => {
    registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'host-a-producer'
    })
    const first = recoverWorkspaceActivation(identity('host-a'), { mode: 'explicit' })
    await Promise.resolve()

    const sshHost = toSshExecutionHostId('box')
    mocks.state().executionHostId = sshHost
    mocks.state().activeWorkspaceExecutionHostId = sshHost
    mocks.notifyStore()
    const second = recoverWorkspaceActivation(identity('host-b', { executionHostId: sshHost }), {
      mode: 'explicit'
    })

    await expect(second).resolves.toMatchObject({
      kind: 'deferred',
      reason: expect.stringContaining('cannot verify the execution host')
    })
    expect(readWorkspaceActivationRecoveryPresentation(WORKSPACE_KEY, sshHost)?.kind).toBe(
      'unverifiable'
    )
    expect(mocks.state().createTab).not.toHaveBeenCalled()
    await expect(first).resolves.toEqual({ kind: 'stale' })
  })

  it.each([
    ['worktree over SSH', WORKSPACE_KEY],
    ['folder over SSH', folderWorkspaceKey('folder-1')]
  ])('does not start a writer for unverifiable %s', async (_label, workspaceKey) => {
    const sshHost = toSshExecutionHostId('box')
    mocks.state().activeWorktreeId = workspaceKey
    mocks.state().executionHostId = sshHost
    mocks.state().activeWorkspaceExecutionHostId = sshHost
    mocks.notifyStore()

    const result = await recoverWorkspaceActivation(
      identity(`ssh-${workspaceKey}`, { workspaceKey, executionHostId: sshHost }),
      { mode: 'explicit' }
    )

    expect(result).toMatchObject({ kind: 'deferred' })
    expect(readWorkspaceActivationRecoveryPresentation(workspaceKey, sshHost)?.kind).toBe(
      'unverifiable'
    )
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('does not treat a previously hydrated but offline SSH host as exited', async () => {
    const sshHost = toSshExecutionHostId('box')
    mocks.state().executionHostId = sshHost
    mocks.state().activeWorkspaceExecutionHostId = sshHost
    mocks.state().remoteWorkspaceHydratedTargetIds.add('box')
    mocks.state().remoteWorkspaceSyncStatusByTargetId.box = { phase: 'offline' }
    mocks.notifyStore()

    await expect(
      recoverWorkspaceActivation(identity('ssh-offline', { executionHostId: sshHost }), {
        mode: 'explicit'
      })
    ).resolves.toMatchObject({ kind: 'deferred' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('keeps synced SSH observation writer-free without producer settlement', async () => {
    const sshHost = toSshExecutionHostId('box')
    mocks.state().executionHostId = sshHost
    mocks.state().activeWorkspaceExecutionHostId = sshHost
    mocks.state().remoteWorkspaceHydratedTargetIds.add('box')
    mocks.state().remoteWorkspaceSyncStatusByTargetId.box = { phase: 'synced' }
    mocks.notifyStore()

    await expect(
      recoverWorkspaceActivation(identity('ssh-synced', { executionHostId: sshHost }), {
        mode: 'explicit'
      })
    ).resolves.toMatchObject({ kind: 'failed', reason: 'unexpected' })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('keeps a producer-owned tab pending until real publication reaches inventory', async () => {
    vi.useFakeTimers()
    showSurface('terminal', 'setup-tab')
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'publication-owner'
    })
    producer.materialized({ kind: 'tab', id: 'not-published' })
    const recovery = recoverWorkspaceActivation(identity('publication-attempt'), {
      mode: 'explicit'
    })
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(recovery).resolves.toMatchObject({
      kind: 'deferred',
      ownerAttemptId: 'publication-owner'
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('settles a producer only from its exact published surface identity', async () => {
    showSurface('terminal', 'setup-tab')
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: WORKSPACE_KEY,
      executionHostId: 'local',
      attemptId: 'exact-publication-owner'
    })
    producer.materialized({ kind: 'tab', id: 'agent-session:session-1' })
    const recovery = recoverWorkspaceActivation(identity('exact-publication-attempt'), {
      mode: 'explicit'
    })
    await Promise.resolve()

    mocks.state().unifiedTabsByWorktree[WORKSPACE_KEY] = [
      { id: 'setup-tab', contentType: 'terminal' },
      { id: 'agent-session:session-1', contentType: 'agent-session' }
    ]
    mocks.notifyStore()

    await expect(recovery).resolves.toEqual({
      kind: 'materialized',
      surface: { id: 'agent-session:session-1', type: 'agent-session' }
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })

  it('lets a reentrant newer activation own final reconciliation', async () => {
    let newerRecovery: Promise<unknown> | null = null
    mocks.runOnNextReconcile(() => {
      showSurface('terminal', 'newer-surface')
      newerRecovery = recoverWorkspaceActivation(identity('reentrant-newer'), {
        mode: 'explicit'
      })
    })

    await expect(
      recoverWorkspaceActivation(identity('reentrant-older'), { mode: 'explicit' })
    ).resolves.toEqual({ kind: 'stale' })
    await expect(newerRecovery).resolves.toEqual({
      kind: 'materialized',
      surface: { id: 'newer-surface', type: 'terminal' }
    })
    expect(mocks.state().createTab).not.toHaveBeenCalled()
  })
})
