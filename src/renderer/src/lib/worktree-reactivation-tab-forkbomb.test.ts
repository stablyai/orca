import { getDefaultSettings } from '../../../shared/constants'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'
import { makeCreatedAgentWorktree as makeWorktree } from '@/lib/worktree-activation-created-agent.test-fixture'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { publishWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  addWorkspace,
  emptySession
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import { layoutApplyTestDouble } from '@/runtime/layout-apply-test-double'
import {
  openWorkspaceLayoutFrameSync,
  type WorkspaceLayoutFrameSync
} from '@/runtime/workspace-layout-frame-sync'

type FrameDouble = { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null }
const frames = vi.hoisted((): FrameDouble => ({ onFrame: null }))
vi.mock('@/runtime/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    frames.onFrame = onFrame
    return { close: () => {} }
  }
}))

const initialAppStoreState = useAppStore.getState()

/**
 * A `session.tabs.list` answer holding no agent-session tab. The gate asks the host for one
 * workspace's snapshot rather than the whole `session.tabs.listAll` inventory, and refuses an answer
 * that does not name the scope it listed — so the fake host has to report its worktree.
 */
function emptySessionTabsSnapshot(worktreeId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function baseState(worktree: ReturnType<typeof makeWorktree>): Partial<AppState> {
  return {
    repos: [
      {
        id: 'repo-1',
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [worktree] },
    activeRepoId: 'repo-1',
    activeView: 'terminal',
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    tabsByWorktree: {},
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
      agentCmdOverrides: {}
    },
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  }
}

let sync: WorkspaceLayoutFrameSync | null = null

/** Main's snapshot: the restored pane it placed at window load, still bound to its live PTY. */
function mainSnapshot(worktreeId: string, tabId: string, leafId: string, ptyId: string) {
  const session = addWorkspace(emptySession(), worktreeId, [
    { id: 'group-main', tabs: [{ id: tabId, leaves: [[leafId, ptyId]] }] }
  ])
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return {
    type: 'snapshot' as const,
    workspaces: Object.entries(layout.workspaces).map(([key, workspace]) => ({
      key,
      layout: publishWorkspaceLayout(workspace, 'local')
    }))
  }
}

afterEach(() => {
  sync?.close()
  sync = null
  provideLayoutFrameTerminalPanes({ holdsTerminalPane: () => false, terminalTab: () => undefined })
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('STA-1111 worktree reopen does not fork-bomb tabs', () => {
  it('defers packaged-startup resume until restored PTYs finish reconnecting', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState({
      ...baseState(worktree),
      workspaceSessionReady: false,
      terminalStartupRestorationReady: false
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `packaged-restart-pane:${leafId}`
    const livePtyId = `${worktree.id}@@daemon-live`
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'packaged-restart-pane',
          worktreeId: worktree.id,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'packaged-session' },
          prompt: 'resume prior task',
          state: 'working',
          origin: 'quit',
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      },
      terminalLayoutsByTabId: {
        'packaged-restart-pane': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: livePtyId }
        }
      }
    })
    const layoutApply = layoutApplyTestDouble()
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn(async (request: { method: string; params?: unknown }) =>
            request.method === 'layout.apply'
              ? layoutApply.call(request)
              : request.method === 'terminal.list'
                ? {
                    ok: true,
                    result: {
                      // The host still binds the restored PTY to its original pane.
                      terminals: [
                        {
                          handle: 'restored-1',
                          ptyId: livePtyId,
                          worktreeId: worktree.id,
                          worktreePath: worktree.path,
                          branch: 'main',
                          tabId: 'packaged-restart-pane',
                          leafId,
                          title: 'Codex',
                          connected: true,
                          writable: true,
                          lastOutputAt: null,
                          preview: ''
                        }
                      ],
                      truncated: false,
                      hostScope: { hostIds: ['local'], omittedHostIds: [] }
                    }
                  }
                : { ok: true, result: emptySessionTabsSnapshot(worktree.id) }
          )
        },
        pty: {
          listSessions: vi.fn(async () => [
            {
              id: livePtyId,
              cwd: worktree.path,
              title: 'Codex',
              agentOwnership: 'present' as const
            }
          ])
        }
      }
    })

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      useAppStore.setState({ unifiedTabsByWorktree: { [worktree.id]: [] } })
      sync = openWorkspaceLayoutFrameSync(useAppStore)
      provideLayoutFrameTerminalPanes(sync)
      frames.onFrame!(mainSnapshot(worktree.id, 'packaged-restart-pane', leafId, livePtyId))
    }

    activateAndRevealWorktree(worktree.id)
    const gate = waitForWorktreeAgentActivationGateForTests(worktree.id)
    await Promise.resolve()
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(0)

    useAppStore.setState({
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true
    })
    await gate
    if (sync) {
      // The window asked main for nothing: main's frame draws the pane it placed.
      expect(layoutApply.commands).toEqual([])
      sync.start()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    const restored = useAppStore.getState()
    expect(restored.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(restored.terminalLayoutsByTabId['packaged-restart-pane']?.ptyIdsByLeafId?.[leafId]).toBe(
      livePtyId
    )
    // A frame-drawn row is a restored row: its pane, not the row, carries the binding until mount.
    expect(restored.tabsByWorktree[worktree.id]?.[0]?.ptyId).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN ? null : livePtyId
    )
    // The host's pane, not a freshly minted duplicate surface.
    expect(restored.tabsByWorktree[worktree.id]?.[0]?.id).toBe('packaged-restart-pane')
    expect(restored.automaticAgentResumeClaimsByTabId).toEqual({})
    expect(restored.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('re-captured sleeping codex session resumes once, not once per reopen', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    const layoutApply = layoutApplyTestDouble()
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn(async (request: { method: string; params?: unknown }) =>
            request.method === 'layout.apply'
              ? layoutApply.call(request)
              : { ok: true, result: emptySessionTabsSnapshot(worktree.id) }
          )
        },
        pty: { listSessions: vi.fn(async () => []) }
      }
    })
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }
    let resumedTabId: string | undefined

    for (let reopen = 0; reopen < 4; reopen++) {
      const paneKey = `slept-pane-${reopen}:0`
      useAppStore.setState((s) => ({
        sleepingAgentSessionsByPaneKey: {
          ...s.sleepingAgentSessionsByPaneKey,
          [paneKey]: {
            paneKey,
            tabId: `slept-pane-${reopen}`,
            worktreeId: worktree.id,
            agent: 'codex',
            providerSession,
            prompt: 'resume prior task',
            state: 'working',
            origin: 'live',
            capturedAt: 1000 + reopen,
            updatedAt: 1000 + reopen,
            terminalTitle: 'Codex'
          }
        }
      }))

      activateAndRevealWorktree(worktree.id)
      await waitForWorktreeAgentActivationGateForTests(worktree.id)
      const state = useAppStore.getState()
      const tabs = state.tabsByWorktree[worktree.id] ?? []

      expect(tabs).toHaveLength(1)
      resumedTabId ??= tabs[0]!.id
      expect(tabs[0]!.id).toBe(resumedTabId)
      expect(state.automaticAgentResumeClaimsByTabId[tabs[0]!.id]?.providerSession).toEqual(
        providerSession
      )
      expect(state.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()

      if (reopen === 0) {
        expect(state.consumeTabStartupCommand(tabs[0]!.id)?.resumeProviderSession).toEqual(
          providerSession
        )
      }
    }
    // A layout-owner build asks main for the resumed tab once; no reopen asks again.
    expect(
      layoutApply.commands.filter((command) => command.type === 'createTerminalTab')
    ).toHaveLength(ORCA_LAYOUT_OWNER_IS_MAIN ? 1 : 0)
  })
})
