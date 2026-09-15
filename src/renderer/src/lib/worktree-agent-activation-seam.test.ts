import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import { activateAndRevealWorktree } from './worktree-activation'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'
import { makeCreatedAgentWorktree as makeWorktree } from './worktree-activation-created-agent-test-state'
import {
  registerWorkspaceSurfaceProducer,
  resetWorkspaceSurfaceProducersForTests
} from './workspace-surface-production'
import {
  readWorkspaceActivationRecoveryPresentation,
  resetWorkspaceActivationRecoveryPresentationsForTests
} from './workspace-activation-recovery-presentation'

const initialState = useAppStore.getState()

function baseState(): Partial<AppState> {
  const worktree = makeWorktree()
  return {
    repos: [
      {
        id: worktree.repoId,
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { [worktree.repoId]: [worktree] },
    activeRepoId: worktree.repoId,
    activeView: 'terminal',
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    settings: {
      agentCmdOverrides: {},
      defaultTuiAgent: 'codex',
      setupScriptLaunchMode: 'new-tab'
    } as AppState['settings'],
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  }
}

function structuredSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'activation-test',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'structured-agent-session-chat-1',
        title: 'Codex Chat',
        sessionId: 'chat-1',
        agent: 'codex',
        isActive: false
      }
    ]
  }
}

function orphanTerminalRow(
  worktree: ReturnType<typeof makeWorktree>,
  ptyId: string
): RuntimeTerminalSummary {
  return {
    handle: 'orphan-1',
    ptyId,
    orphaned: true,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    branch: worktree.branch ?? 'main',
    tabId: `pty:${ptyId}`,
    leafId: `pty:${ptyId}`,
    title: 'Codex',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: ''
  }
}

function stubInventory(args?: {
  structured?: boolean
  livePtyId?: string
  /** Host that could not produce a complete census for the workspace it was asked about. */
  unverifiableCensus?: boolean
}): {
  runtimeCall: ReturnType<typeof vi.fn>
  listSessions: ReturnType<typeof vi.fn>
} {
  const worktree = makeWorktree()
  const runtimeCall = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'session.tabs.list') {
      return {
        ok: true,
        result: args?.structured
          ? structuredSnapshot(worktree.id)
          : { ...structuredSnapshot(worktree.id), tabs: [] }
      }
    }
    if (method === 'agentSession.handoffStatus') {
      return { ok: true, result: { owner: 'native' } }
    }
    if (method === 'terminal.list') {
      // The host knows this PTY but binds it to no surface, so adoption may mint one.
      return {
        ok: true,
        result: {
          terminals: args?.unverifiableCensus
            ? []
            : args?.livePtyId
              ? [orphanTerminalRow(worktree, args.livePtyId)]
              : [],
          truncated: false,
          hostScope: args?.unverifiableCensus
            ? { hostIds: [], omittedHostIds: ['local', 'runtime:env-9'] }
            : { hostIds: ['local'], omittedHostIds: [] }
        }
      }
    }
    throw new Error(`Unexpected runtime method: ${method}`)
  })
  const listSessions = vi.fn(async () =>
    args?.livePtyId
      ? [
          {
            id: args.livePtyId,
            cwd: worktree.path,
            title: 'Codex',
            agentOwnership: 'present' as const
          }
        ]
      : []
  )
  const runtimeSubscribe = vi.fn(
    async (
      request: { method: string; params?: unknown },
      callback: (response: unknown) => void
    ) => {
      callback(await runtimeCall(request))
      return { unsubscribe: vi.fn() }
    }
  )
  vi.stubGlobal('window', {
    api: {
      runtime: { call: runtimeCall, subscribe: runtimeSubscribe },
      runtimeEnvironments: { subscribe: vi.fn() },
      pty: { listSessions }
    }
  })
  return { runtimeCall, listSessions }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetWorkspaceSurfaceProducersForTests()
  resetWorkspaceActivationRecoveryPresentationsForTests()
  useAppStore.setState(initialState, true)
})

describe('worktree agent activation seam', () => {
  it('keeps a projected chat-only workspace terminal-free', async () => {
    const worktree = makeWorktree()
    const groupId = 'chat-group'
    useAppStore.setState({
      ...baseState(),
      unifiedTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'structured-agent-session-chat-1',
            entityId: 'chat-1',
            groupId,
            worktreeId: worktree.id,
            contentType: 'agent-session',
            label: 'Codex Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktree.id]: [
          {
            id: groupId,
            worktreeId: worktree.id,
            activeTabId: 'structured-agent-session-chat-1',
            tabOrder: ['structured-agent-session-chat-1']
          }
        ]
      },
      activeGroupIdByWorktree: { [worktree.id]: groupId }
    })
    const { runtimeCall, listSessions } = stubInventory()

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await waitForWorktreeAgentActivationGateForTests(worktree.id)

    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('adopts a live terminal without spawning a fallback', async () => {
    const worktree = makeWorktree()
    const livePtyId = `${worktree.id}@@live-codex`
    useAppStore.setState(baseState())
    stubInventory({ livePtyId })

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await vi.waitFor(() =>
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
    )
    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.ptyId).toBe(livePtyId)
  })

  it('spawns a fallback when the workspace has no agent', async () => {
    const worktree = makeWorktree()
    useAppStore.setState(baseState())
    stubInventory()

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await vi.waitFor(() =>
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
    )
    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.ptyId).toBeNull()
  })

  it('re-seeds an explicitly activated workspace with a closed terminal tombstone', async () => {
    const worktree = makeWorktree()
    useAppStore.setState({
      ...baseState(),
      // An empty row is persisted after the user closes the last terminal.
      tabsByWorktree: { [worktree.id]: [] }
    })
    stubInventory()

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await vi.waitFor(() =>
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
    )
    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    // A fresh shell, never a second surface forked onto the live agent's PTY.
    expect(tabs[0]?.ptyId).toBeNull()
  })

  it('does not race a registered surface producer with a fallback terminal', async () => {
    const worktree = makeWorktree()
    useAppStore.setState(baseState())
    stubInventory()
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: worktree.id,
      executionHostId: 'local'
    })

    expect(activateAndRevealWorktree(worktree.id)).toEqual({
      primaryTabId: null
    })
    await Promise.resolve()

    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
    producer.materialized({ kind: 'workspace-content', id: 'requested-content' })
    await producer.attempt.result
  })

  it('does not treat an unrelated surviving browser as completion of a requested launch', async () => {
    const worktree = makeWorktree()
    useAppStore.setState(baseState())
    useAppStore.getState().createBrowserTab(worktree.id, 'https://example.com', { activate: true })

    expect(
      activateAndRevealWorktree(worktree.id, {
        startup: { command: 'codex', launchAgent: 'codex' }
      })
    ).toEqual({ primaryTabId: null })

    await vi.waitFor(() =>
      expect(readWorkspaceActivationRecoveryPresentation(worktree.id, 'local')?.kind).toBe(
        'producer-failed'
      )
    )
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
  })

  it('shows a blocked recovery without seeding when a live PTY cannot be safely surfaced', async () => {
    const worktree = makeWorktree()
    const livePtyId = `${worktree.id}@@live-codex`
    useAppStore.setState(baseState())
    stubInventory({ livePtyId, unverifiableCensus: true })

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await vi.waitFor(() =>
      expect(readWorkspaceActivationRecoveryPresentation(worktree.id, 'local')?.kind).toBe(
        'blocked'
      )
    )
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
  })

  it('does not spawn before a structured chat tab hydrates', async () => {
    const worktree = makeWorktree()
    useAppStore.setState(baseState())
    const { runtimeCall, listSessions } = stubInventory({ structured: true })

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalled())

    expect(useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).toHaveLength(0)
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'session.tabs.list',
      params: { worktree: `id:${worktree.id}` }
    })
    expect(listSessions).not.toHaveBeenCalled()
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'terminal.list',
      params: {
        worktree: `id:${worktree.id}`,
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false
      }
    })
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'agentSession.handoffStatus',
      params: { sessionId: 'chat-1' }
    })
  })

  it('keeps a paired-runtime launch producer authoritative when host creation fails', async () => {
    const worktree = makeWorktree()
    useAppStore.setState({
      ...baseState(),
      worktreesByRepo: { [worktree.repoId]: [{ ...worktree, hostId: 'runtime:env-1' }] }
    })
    const { listSessions } = stubInventory()

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await vi.waitFor(() =>
      expect(readWorkspaceActivationRecoveryPresentation(worktree.id, 'runtime:env-1')?.kind).toBe(
        'producer-failed'
      )
    )
    expect(listSessions).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
  })

  it('shows reconnect recovery without starting a requested writer when SSH is detached', async () => {
    const worktree = makeWorktree()
    useAppStore.setState({
      ...baseState(),
      worktreesByRepo: { [worktree.repoId]: [{ ...worktree, hostId: 'ssh:box' }] },
      remoteWorkspaceSyncStatusByTargetId: { box: { phase: 'offline' } as never }
    })
    const { listSessions } = stubInventory()
    listSessions.mockImplementation(async (scope?: unknown) => {
      if (scope) {
        throw new Error('No PTY provider for connection "box": the SSH relay is not attached')
      }
      return []
    })

    expect(
      activateAndRevealWorktree(worktree.id, {
        startup: { command: 'codex', launchAgent: 'codex' }
      })
    ).toEqual({ primaryTabId: null })
    await vi.waitFor(() =>
      expect(readWorkspaceActivationRecoveryPresentation(worktree.id, 'ssh:box')?.kind).toBe(
        'unverifiable'
      )
    )
    expect(listSessions).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
  })
})
