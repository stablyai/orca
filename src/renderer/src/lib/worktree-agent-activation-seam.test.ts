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
    if (method === 'session.tabs.listAll') {
      return {
        ok: true,
        result: { snapshots: args?.structured ? [structuredSnapshot(worktree.id)] : [] }
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
  vi.stubGlobal('window', { api: { runtime: { call: runtimeCall }, pty: { listSessions } } })
  return { runtimeCall, listSessions }
}

afterEach(() => {
  vi.unstubAllGlobals()
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
    await waitForWorktreeAgentActivationGateForTests(worktree.id)

    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.ptyId).toBe(livePtyId)
  })

  it('spawns a fallback when the workspace has no agent', async () => {
    const worktree = makeWorktree()
    useAppStore.setState(baseState())
    stubInventory()

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await waitForWorktreeAgentActivationGateForTests(worktree.id)

    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.ptyId).toBeNull()
  })

  it('does not race an explicitly promised surface with a fallback terminal', async () => {
    const worktree = makeWorktree()
    useAppStore.setState(baseState())
    stubInventory()

    expect(activateAndRevealWorktree(worktree.id, { providesInitialSurface: true })).toEqual({
      primaryTabId: null
    })
    await waitForWorktreeAgentActivationGateForTests(worktree.id)

    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
  })

  // A paired-runtime owner is always omitted from its own scoped census, and an SSH relay that
  // never answered omits everything. Declining to mint is right; leaving the workspace with no
  // surface at all is not — the user asked for a pane and must get one.
  it('still seeds a usable pane when the census cannot prove who owns a live PTY', async () => {
    const worktree = makeWorktree()
    const livePtyId = `${worktree.id}@@live-codex`
    useAppStore.setState(baseState())
    stubInventory({ livePtyId, unverifiableCensus: true })

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await waitForWorktreeAgentActivationGateForTests(worktree.id)

    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    // A fresh shell, never a second surface forked onto the live agent's PTY.
    expect(tabs[0]?.ptyId).toBeNull()
  })

  it('does not spawn before a structured chat tab hydrates', async () => {
    const worktree = makeWorktree()
    useAppStore.setState(baseState())
    const { runtimeCall } = stubInventory({ structured: true })

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await waitForWorktreeAgentActivationGateForTests(worktree.id)

    expect(useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).toHaveLength(0)
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)
    expect(runtimeCall).toHaveBeenCalledWith({ method: 'session.tabs.listAll', params: {} })
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'agentSession.handoffStatus',
      params: { sessionId: 'chat-1' }
    })
  })
})
