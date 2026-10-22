// A paired server for the server layout frame tests: its session.tabs snapshots, its layout in the
// server's own ids, its status entry, and the layout streams the desktop opens to it.

import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { RuntimeMobileSessionTabsResult, RuntimeStatus } from '../../../shared/runtime-types'
import {
  LAYOUT_INTENTS_RUNTIME_CAPABILITY,
  LAYOUT_REOPEN_HELD_PANES_CAPABILITY
} from '../../../shared/workspace-layout/layout-intents-capability'
import type {
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from '@/store/types'
import type { RuntimeLayoutStreamStatus } from './runtime-layout-client'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { createTestStore } from '../store/slices/store-test-helpers'
import { installServerLayoutFrames } from './server-layout-frames'
import { applyWebSessionTabsSnapshotWithContext } from './web-session-tabs-sync/apply-snapshot'

export const ENV = 'web-env-1'
export const WT = 'repo::/worktree'
export const NOW = 1_700_000_000_000
export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

export const HOST_GROUP = 'host-group-1'

/** One host terminal surface; a null handle is session.tabs' `pending-handle`. */
export function surface(hostTabId: string, leafId: string, terminal: string | null) {
  const base = {
    type: 'terminal' as const,
    id: `${hostTabId}::${leafId}`,
    title: hostTabId,
    parentTabId: hostTabId,
    leafId,
    isActive: hostTabId === 'host-tab-1'
  }
  return terminal === null
    ? { ...base, status: 'pending-handle' as const, terminal: null }
    : { ...base, status: 'ready' as const, terminal }
}

export function sessionTabs(
  surfaces: ReturnType<typeof surface>[],
  snapshotVersion: number
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: HOST_GROUP,
    activeTabId: surfaces.find((tab) => tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs: surfaces
  }
}

/** A terminal tab as the server publishes it: its own ids, its own pty. */
export function serverTerminalTab(
  hostTabId: string,
  leafId: string,
  serverPtyId: string | null,
  createdAt = NOW
): PublishedTab {
  return {
    id: hostTabId,
    kind: 'terminal',
    entityId: hostTabId,
    executionHostId: 'local',
    createdAt,
    customTitle: null,
    color: null,
    isPinned: false,
    isPreview: false,
    terminal: {
      root: { type: 'leaf', leafId },
      panes: [{ leafId, ...(serverPtyId ? { ptyId: serverPtyId } : {}) }],
      defaultTitle: hostTabId
    }
  }
}

export function serverLayout(tabs: PublishedTab[]): PublishedWorkspaceLayout {
  return {
    worktreeId: WT,
    groups: [{ id: HOST_GROUP, tabIds: tabs.map((tab) => tab.id) }],
    groupLayout: { type: 'leaf', groupId: HOST_GROUP },
    tabs,
    editorFiles: [],
    browserTabs: []
  }
}

export function runtimeStatusEntry(
  runtimeId: string,
  capable: boolean,
  disconnected = false,
  reopensHeldPanes = false
): RuntimeEnvironmentStatus {
  const status: RuntimeStatus = {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    ...(capable
      ? {
          capabilities: [
            LAYOUT_INTENTS_RUNTIME_CAPABILITY,
            ...(reopensHeldPanes ? [LAYOUT_REOPEN_HELD_PANES_CAPABILITY] : [])
          ]
        }
      : {})
  }
  if (!disconnected) {
    return { status, checkedAt: 1 }
  }
  // A retired pairing: the verified status stays, and the host reads disconnected.
  return {
    status,
    checkedAt: 1,
    snapshot: {
      environmentId: 'unused',
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      status,
      verification: 'verified',
      transport: 'ready',
      retired: true
    }
  }
}

/** A paired server as the catalog lists it. */
export function runtimeEnvironment(
  id: string,
  runtimeId: string,
  pairingRevision: number
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision,
    lastUsedAt: null,
    runtimeId,
    endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://server' }],
    preferredEndpointId: 'ws-1'
  }
}

type MirrorStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
}

/** Applies one session.tabs snapshot the way the mirror commits it. */
export function mirrorSnapshot(
  store: MirrorStore,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  store.setState(
    applyWebSessionTabsSnapshotWithContext(store.getState(), snapshot, environmentId, NOW)
  )
}

export type FakeLayoutStream = {
  target: RuntimeClientTarget
  onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  onStatus: (status: RuntimeLayoutStreamStatus) => void
  onPosition: ((seq: number) => void) | undefined
  close: () => void
  closed: boolean
}

/** Every layout subscription the code under test opened, in order. */
export function createFakeLayoutStreams() {
  const all: FakeLayoutStream[] = []
  const subscribe = (
    target: RuntimeClientTarget,
    _params: unknown,
    onFrame: FakeLayoutStream['onFrame'],
    onStatus: FakeLayoutStream['onStatus'],
    onPosition?: (seq: number) => void
  ): { close: () => void } => {
    const stream: FakeLayoutStream = {
      target,
      onFrame,
      onStatus,
      onPosition,
      closed: false,
      close: () => {
        stream.closed = true
      }
    }
    all.push(stream)
    return { close: () => stream.close() }
  }
  const of = (environmentId: string): FakeLayoutStream[] =>
    all.filter(
      (stream) =>
        stream.target.kind === 'environment' && stream.target.environmentId === environmentId
    )
  /** The one open stream to a server; throws unless exactly one is open. */
  const openTo = (environmentId: string): FakeLayoutStream => {
    const open = of(environmentId).filter((stream) => !stream.closed)
    if (open.length !== 1) {
      throw new Error(`expected one open stream to ${environmentId}, found ${open.length}`)
    }
    return open[0]!
  }
  /** Delivers a frame as the client does: the frame, then its position. */
  const send = (stream: FakeLayoutStream, frame: WorkspaceLayoutChangeFrame): void => {
    stream.onFrame(frame)
    const seq = 'seq' in frame ? frame.seq : undefined
    if (seq !== undefined) {
      stream.onPosition?.(seq)
    }
  }
  return { all, subscribe, of, openTo, send }
}

export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** What a reattach or an emptied workspace would change: tab ids, groups and pane bindings. */
export function treeOf(state: AppState, key: string) {
  const tabIds = (state.tabsByWorktree[key] ?? []).map((tab) => tab.id)
  return {
    tabIds,
    unifiedIds: (state.unifiedTabsByWorktree[key] ?? []).map((tab) => tab.id),
    groups: (state.groupsByWorktree[key] ?? []).map((group) => [group.id, group.tabOrder]),
    bindings: Object.fromEntries(
      tabIds.map((id) => [id, state.terminalLayoutsByTabId[id]?.ptyIdsByLeafId])
    )
  }
}

export type Server = {
  environmentId: string
  runtimeId: string
  pairingRevision?: number
  capable: boolean
  /** Paired still, but the host's own verdict is that the pairing is over. */
  disconnected?: boolean
  /** Also serves `layout.reopenHeldPanes`. */
  reopensHeldPanes?: boolean
}

export const CAPABLE: Server = { environmentId: ENV, runtimeId: 'runtime-1', capable: true }

/** ENV's one workspace as the server publishes it, bound to its own `server-pty-1`. */
export const SERVER_LAYOUT = serverLayout([
  serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1')
])

export type TestStore = ReturnType<typeof createTestStore>

/** The reachable servers and workspace owners a test's mocks read, and its installed managers. */
export function createServerHarness(mocks: { owners: Map<string, string> }) {
  const installs: (() => void)[] = []
  return {
    /** The paired servers, and what each one's verified status advertises. */
    setServers: (store: TestStore, servers: Server[]): void => {
      store.setState({
        runtimeEnvironments: servers.map((server) =>
          runtimeEnvironment(server.environmentId, server.runtimeId, server.pairingRevision ?? 1)
        ),
        runtimeStatusByEnvironmentId: new Map(
          servers.map((server) => [
            server.environmentId,
            runtimeStatusEntry(
              server.runtimeId,
              server.capable,
              server.disconnected,
              server.reopensHeldPanes
            )
          ])
        )
      })
    },
    /** A store whose WT mirrors ENV's one terminal, bound to `terminal-1`. */
    mirroredStore: (): TestStore => {
      const store = createTestStore()
      mocks.owners.set(WT, ENV)
      mirrorSnapshot(store, ENV, sessionTabs([surface('host-tab-1', LEAF_ID, 'terminal-1')], 1))
      return store
    },
    install: (store: TestStore): void => {
      installs.push(installServerLayoutFrames(store))
    },
    uninstallAll: (): void => {
      for (const uninstall of installs.splice(0)) {
        uninstall()
      }
    }
  }
}

/** A sender's opening snapshot with the stream epoch its records frames carry. */
export function senderSnapshot(
  sender: {
    snapshot: (layouts: Record<string, PublishedWorkspaceLayout>, seq?: number) => unknown
  },
  layouts: Record<string, PublishedWorkspaceLayout>,
  seq: number
): WorkspaceLayoutChangeFrame {
  sender.snapshot(layouts, seq)
  return {
    type: 'snapshot',
    workspaces: Object.entries(layouts).map(([key, layout]) => ({ key, layout })),
    seq,
    epoch: 'main-epoch'
  }
}
