// Layout-owner build, two restarts: a terminal recorded only on its tab (an older session, or an
// unvisited SSH relay tab) must reattach after each one. Runs main's Loader, the window's startup
// hydration and reconnect, main's frames and main's save join, as the app does.

import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { publishWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-published'
import {
  addWorkspace,
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  leaf
} from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bindTabTerminalPanesInSession } from '../../../../main/persistence/restoring-sessions/tab-terminal-pane-binding-repair'
import { windowViewSaveForMain } from '../../../../main/persistence/window-save-view'
import { deriveShutdownReconnectFacts } from '../../../../main/runtime/terminal/recovery/shutdown-reconnect-facts'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { buildWorkspaceSessionHostSnapshots } from '@/lib/workspace-session-host-persistence'
import {
  bootWindowFromPartitions,
  type StoredPartition
} from '../../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../slices/store-session-test-harness'
import { createTestStore } from '../slices/store-test-helpers'
import { getOrphanTerminalIds } from '../slices/terminal-orphan-helpers'
import { buildLayoutFrameSlices } from '../workspace-layout-frame-slices'
import { buildLayoutFrameStorePatch } from '../workspace-layout-frame-store-patch'
import type { AppState } from '../types'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// Main's frames are applied by hand below; the window's own stream has no main to reach here.
vi.mock('@/runtime/workspace-layout-frame-sync', () => ({ showStartupLayoutFrames: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const TARGET_ID = 'target'
const SSH_HOST = toSshExecutionHostId(TARGET_ID)
const SSH_KEY = 'repo-ssh::/home/dev/api'
const RELAY_PTY_ID = 'ssh:target@@pty-42'

/** The pane's saved layout binds nothing: the terminal is named only on the tab. */
function tabLevelOnly(session: WorkspaceSessionState, tabId: string, ptyId: string): void {
  for (const rows of Object.values(session.tabsByWorktree)) {
    const row = rows.find((candidate) => candidate.id === tabId)
    if (row) {
      row.ptyId = ptyId
    }
  }
  delete session.terminalLayoutsByTabId[tabId]!.ptyIdsByLeafId
}

/** What an older build left: a git and a folder workspace, and an SSH tab never visited. */
function storedBeforeUpgrade(): StoredPartition[] {
  const local = addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-g', activeTabId: 'tab-g', tabs: [{ id: 'tab-g', leaves: [[leaf(1)]] }] }
  ])
  addWorkspace(local, FOLDER_KEY, [
    { id: 'group-f', activeTabId: 'tab-f', tabs: [{ id: 'tab-f', leaves: [[leaf(2)]] }] }
  ])
  tabLevelOnly(local, 'tab-g', 'pty-git')
  tabLevelOnly(local, 'tab-f', 'pty-folder')
  local.activeWorktreeIdsOnShutdown = [GIT_KEY, FOLDER_KEY]
  const ssh = addWorkspace(
    emptySession(),
    SSH_KEY,
    [{ id: 'group-s', activeTabId: 'tab-s', tabs: [{ id: 'tab-s', leaves: [[leaf(3)]] }] }],
    SSH_HOST
  )
  tabLevelOnly(ssh, 'tab-s', RELAY_PTY_ID)
  ssh.remoteSessionIdsByTabId = { 'tab-s': RELAY_PTY_ID }
  ssh.activeWorktreeIdsOnShutdown = [SSH_KEY]
  ssh.activeConnectionIdsAtShutdown = [TARGET_ID]
  return [
    { hostId: LOCAL_EXECUTION_HOST_ID, session: local },
    { hostId: SSH_HOST, session: ssh }
  ]
}

type Launched = {
  store: ReturnType<typeof createTestStore>
  /** What main's Store holds after its load repairs: the window reads it, main saves over it. */
  stored: StoredPartition[]
  /** Tab id → the terminal main's frame binds to its first pane. */
  mainPaneTerminals: Map<string, string | undefined>
}

/** Main's frames for a stored partition, laid over the window's store. */
function applyMainFrames(
  { store, mainPaneTerminals }: Launched,
  hostId: ExecutionHostId,
  stored: WorkspaceSessionState
): void {
  const { layout, facts, desktopView } = loadWorkspaceLayoutWithoutReport(
    hostId,
    structuredClone(stored),
    nameBasedLoadContext()
  )
  const layouts = Object.fromEntries(
    Object.entries(layout.workspaces).map(([key, workspace]) => [
      key,
      publishWorkspaceLayout(workspace, hostId)
    ])
  )
  for (const published of Object.values(layouts)) {
    for (const tab of published.tabs) {
      if (tab.kind === 'terminal') {
        mainPaneTerminals.set(tab.entityId, tab.terminal?.panes[0]?.ptyId)
      }
    }
  }
  const slices = buildLayoutFrameSlices({ layouts, facts, view: desktopView })
  store.setState(buildLayoutFrameStorePatch(store.getState(), slices, Object.keys(layouts)))
}

/** One app launch: main's load, the window's hydration and reconnect, then main's frames. */
async function launch(onDisk: StoredPartition[]): Promise<Launched> {
  const partitions = onDisk.map(({ hostId, session }) => ({
    hostId,
    session: bindTabTerminalPanesInSession(session, () => hostId === SSH_HOST)
  }))
  const store = createTestStore()
  const launched: Launched = { store, stored: partitions, mainPaneTerminals: new Map() }
  store.setState({
    sshConnectionStates: new Map([
      [TARGET_ID, { targetId: TARGET_ID, status: 'connected', error: null, reconnectAttempt: 0 }]
    ]),
    sshTargetsHydrated: true,
    sshTargetLabels: new Map([[TARGET_ID, 'api host']]),
    hydrationSucceeded: true
  })
  await bootWindowFromPartitions(store, partitions)
  await store.getState().reconnectPersistedTerminals()
  for (const { hostId, session } of partitions) {
    applyMainFrames(launched, hostId, session)
  }
  return launched
}

/** The terminal a tab's one pane binds in the window's store, drawn from main's frame. */
function windowPaneTerminal(state: AppState, tabId: string): string | undefined {
  const layout = state.terminalLayoutsByTabId[tabId]
  return layout?.root?.type === 'leaf' ? layout.ptyIdsByLeafId?.[layout.root.leafId] : undefined
}

/** The window's quit save, through main's save join, per partition. */
function quit({ store, stored }: Launched): StoredPartition[] {
  const payload = buildWorkspaceSessionPayload(store.getState())
  const snapshots = buildWorkspaceSessionHostSnapshots(payload, store.getState())
  return stored.map(({ hostId, session }) => {
    const save = snapshots.find(
      (snapshot) => (snapshot.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
    )
    // Main derives what the next startup reconnects from its own terminals and SSH connections.
    const reconnectFacts = (saved: WorkspaceSessionState) =>
      deriveShutdownReconnectFacts(saved, {
        isLiveLocalPty: (ptyId) => ptyId === 'pty-git' || ptyId === 'pty-folder',
        isKnownExited: () => false,
        sshStatusByTargetId: new Map([[TARGET_ID, 'connected']])
      })
    return {
      hostId,
      session: save ? windowViewSaveForMain(session, save.state, hostId, reconnectFacts) : session
    }
  })
}

const EXPECTED = [
  [GIT_KEY, 'tab-g', 'pty-git'],
  [FOLDER_KEY, 'tab-f', 'pty-folder'],
  [SSH_KEY, 'tab-s', RELAY_PTY_ID]
] as const

/** Main binds each pane, the window's pane reattaches to it, and the row advertises it. */
function expectReattaches({ store, mainPaneTerminals }: Launched): void {
  const state = store.getState()
  for (const [key, tabId, ptyId] of EXPECTED) {
    expect(mainPaneTerminals.get(tabId), tabId).toBe(ptyId)
    expect(windowPaneTerminal(state, tabId), tabId).toBe(ptyId)
    expect(state.tabsByWorktree[key]!.find((row) => row.id === tabId)?.ptyId, tabId).toBe(ptyId)
  }
  expect([...getOrphanTerminalIds(state, SSH_KEY)]).toEqual([])
}

describe('restored tab-level terminals across two restarts (layout owner is main)', () => {
  it('reattach after each restart, and the SSH relay id survives while unvisited', async () => {
    const first = storedBeforeUpgrade()
    const firstRun = await launch(first)
    expectReattaches(firstRun)
    // A live title change makes main's save join rewrite each tab's records.
    for (const tabId of ['tab-g', 'tab-f', 'tab-s']) {
      firstRun.store.getState().updateTabTitle(tabId, `vim ${tabId}`)
    }

    const second = quit(firstRun)
    // Main's save keeps the binding its load repair made, so the next load needs no repair.
    const local = second.find(({ hostId }) => hostId === LOCAL_EXECUTION_HOST_ID)!.session
    expect(local.terminalLayoutsByTabId['tab-g']?.ptyIdsByLeafId).toEqual({ [leaf(1)]: 'pty-git' })
    const ssh = second.find(({ hostId }) => hostId === SSH_HOST)!.session
    expect(ssh.terminalLayoutsByTabId['tab-s']?.ptyIdsByLeafId).toEqual({ [leaf(3)]: RELAY_PTY_ID })
    expect(ssh.remoteSessionIdsByTabId).toEqual({ 'tab-s': RELAY_PTY_ID })
    expect(ssh.activeConnectionIdsAtShutdown).toEqual([TARGET_ID])

    const secondRun = await launch(second)
    expectReattaches(secondRun)
    const third = quit(secondRun)
    expect(
      third.find(({ hostId }) => hostId === SSH_HOST)!.session.remoteSessionIdsByTabId
    ).toEqual({ 'tab-s': RELAY_PTY_ID })
  })
})
