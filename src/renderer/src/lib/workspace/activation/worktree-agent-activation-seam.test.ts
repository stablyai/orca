import { getDefaultSettings } from '../../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { RuntimeTerminalSummary } from '../../../../../shared/runtime-terminal-contracts'
import '../../agent-session/resume/resume-sleeping-agent-session'
import { activateAndRevealWorktree } from './worktree-activation'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'
import { makeCreatedAgentWorktree as makeWorktree } from './worktree-activation-created-agent.test-fixture'
import { emptySession } from '../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

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
      ...getDefaultSettings(''),
      agentCmdOverrides: {},
      defaultTuiAgent: 'codex'
    },
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
  vi.stubGlobal('window', { api: { runtime: { call: runtimeCall }, pty: { listSessions } } })
  return { runtimeCall, listSessions }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
  layoutApplyTestTransport.reset()
})

describe('worktree agent activation seam', () => {
  it('adopts a live terminal without spawning a fallback', async () => {
    const worktree = makeWorktree()
    const livePtyId = `${worktree.id}@@live-codex`
    // Restored with no tabs: frames draw this workspace.
    useAppStore.setState({ ...baseState(), unifiedTabsByWorktree: { [worktree.id]: [] } })
    stubInventory({ livePtyId })
    // A switch-on build shows the adopted terminal from main's frame.
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.useMainModel(loadMainLayoutModel('local', emptySession()))
    const frames = openWorkspaceLayoutFrameSync(useAppStore)
    frames.start()
    try {
      expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
      await waitForWorktreeAgentActivationGateForTests(worktree.id)
      await layoutApplyTestTransport.settle()

      const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
      expect(tabs).toHaveLength(1)
      // Switch-on, the pane binds to the terminal main's frame names; the row keeps no ptyId.
      const shownPtyId = ORCA_LAYOUT_OWNER_IS_MAIN
        ? frames.terminalTab(worktree.id, tabs[0]!.id)?.terminal?.panes[0]?.ptyId
        : tabs[0]?.ptyId
      expect(shownPtyId).toBe(livePtyId)
    } finally {
      frames.close()
    }
  })

  it('blocks seeding while detached and allows activation once the SSH target is connected', async () => {
    const worktree = makeWorktree()
    useAppStore.setState({
      ...baseState(),
      worktreesByRepo: { [worktree.repoId]: [{ ...worktree, hostId: 'ssh:box' }] },
      sshConnectionStates: new Map([
        ['box', { targetId: 'box', status: 'connected', error: null, reconnectAttempt: 0 }]
      ])
    })
    const { listSessions } = stubInventory()
    listSessions.mockImplementation(async (scope?: unknown) => {
      if (scope) {
        throw new Error('No PTY provider for connection "box": the SSH relay is not attached')
      }
      return []
    })

    expect(activateAndRevealWorktree(worktree.id)).toEqual({ primaryTabId: null })
    await expect(waitForWorktreeAgentActivationGateForTests(worktree.id)).resolves.toBe('blocked')
    expect(listSessions.mock.calls).toEqual([[{ connectionId: 'box' }]])
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)

    listSessions.mockResolvedValue([])
    activateAndRevealWorktree(worktree.id)
    await expect(waitForWorktreeAgentActivationGateForTests(worktree.id)).resolves.toBe('empty')
    expect(listSessions.mock.calls).toEqual([[{ connectionId: 'box' }], [{ connectionId: 'box' }]])
    await vi.waitFor(() =>
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
    )
    expect(useAppStore.getState().tabsByWorktree[worktree.id]?.[0]?.ptyId).toBeNull()
  })
})
