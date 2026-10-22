import { vi, type Mock } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { AppState } from '../../types'
import { persistWorktreeMeta } from '../worktrees/metadata/worktree-meta-persist'
import { createTestStore, makeTab, makeWorktree, TEST_REPO } from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { createUnreadBadgeCountSelector } from '@/lib/unread-badge-count-selector'
import {
  resetFloatingWorkspaceUnreadSelectorCacheForTest,
  selectFloatingWorkspaceHasUnread
} from '@/store/selectors'
import { startOnScreenAttentionScan } from '@/hooks/on-screen-attention-scan'

// Store setup and observables for the unread characterization suites; the events live in the driver.

export type AttentionStore = ReturnType<typeof createTestStore>

export type PaneTarget = { worktreeId: string; tabId: string; paneKey: string }

export const WS_A = 'repo1::/path/a'
export const WS_B = 'repo1::/path/b'
export const LEAF_1 = '11111111-1111-4111-8111-111111111111'
export const LEAF_2 = '22222222-2222-4222-8222-222222222222'

export type PersistCall = {
  kind: 'worktree' | 'folder'
  id: string
  updates: Record<string, unknown>
  executionHostId?: string
}

/** Returns the notifications dismiss mock the read paths call. */
export function installAttentionMockApi(): Mock<
  (ids: string[], paneKeys?: string[]) => Promise<void>
> {
  const dismiss = vi.fn<(ids: string[], paneKeys?: string[]) => Promise<void>>()
  dismiss.mockResolvedValue(undefined)
  Object.assign(createTabsSliceMockApi(), { notifications: { dismiss }, agentStatus: {} })
  return dismiss
}

/** The window the production on-screen scan runs in, driven by the test. */
export type AttentionScreen = {
  setWindowOnScreen: (onScreen: boolean) => void
  /** Trusted window input: pointerdown, pointermove, or a capture-phase keydown (xterm included). */
  input: () => void
}

const screens = new WeakMap<AttentionStore, AttentionScreen>()

export function screenOf(store: AttentionStore): AttentionScreen {
  const screen = screens.get(store)
  if (!screen) {
    throw new Error('store has no attention screen')
  }
  return screen
}

/**
 * Runs the hook's scan against `store`, with the window's visibility+focus behind a fake document
 * so marking and the scan read the same gate; no native idle query keeps it synchronous.
 */
export function installAttentionScreen(
  store: AttentionStore,
  onScreen: boolean,
  /** Main's desktop idle answer; undefined runs ungated, like a browser. */
  desktopAway?: boolean | (() => boolean)
): void {
  let windowOnScreen = onScreen
  vi.stubGlobal('document', {
    get visibilityState() {
      return windowOnScreen ? 'visible' : 'hidden'
    },
    hasFocus: () => windowOnScreen
  })
  let rescan = (): void => {}
  let input = (): void => {}
  startOnScreenAttentionScan(store, {
    readDesktopAway:
      desktopAway === undefined
        ? null
        : async () => (typeof desktopAway === 'function' ? desktopAway() : desktopAway),
    subscribeStructuredViews: () => () => {},
    subscribePresenceSignals: (onRescan, onInput) => {
      rescan = onRescan
      input = onInput
      return () => {}
    }
  })
  screens.set(store, {
    setWindowOnScreen: (next) => {
      windowOnScreen = next
      rescan()
    },
    input: () => input()
  })
}

export function createAttentionStore(options?: {
  experimental?: boolean
  /** Orca's window starts visible and focused unless false. */
  windowOnScreen?: boolean
  desktopAway?: boolean | (() => boolean)
}): {
  store: AttentionStore
  persists: () => PersistCall[]
} {
  const store = createTestStore()
  const folderUpdates: PersistCall[] = []
  const updateFolderWorkspace = vi.fn<AppState['updateFolderWorkspace']>(
    async (id, updates, opts) => {
      folderUpdates.push({
        kind: 'folder',
        id,
        updates: { ...updates },
        ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {})
      })
      return true
    }
  )
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a' }),
        makeWorktree({ id: WS_B, repoId: 'repo1', path: '/path/b' })
      ]
    },
    activeWorktreeId: WS_B,
    settings: {
      ...getDefaultSettings('/home/test'),
      experimentalTerminalAttention: options?.experimental === true
    },
    updateFolderWorkspace
  })
  installAttentionScreen(store, options?.windowOnScreen !== false, options?.desktopAway)
  return {
    store,
    persists: () => {
      const persistMock = vi.mocked(persistWorktreeMeta)
      const worktreeCalls = persistMock.mock.calls.map(
        ([, id, updates, executionHostId]): PersistCall => ({
          kind: 'worktree',
          id,
          updates: { ...updates },
          ...(executionHostId ? { executionHostId } : {})
        })
      )
      const drained = [...worktreeCalls, ...folderUpdates]
      persistMock.mockClear()
      folderUpdates.length = 0
      return drained
    }
  }
}

/** A live terminal tab with one pane; returns its pane target. */
export function addLiveTerminalTab(
  store: AttentionStore,
  worktreeId: string,
  tabId: string,
  leafId: string = LEAF_1,
  targetGroupId?: string
): PaneTarget {
  store.getState().createUnifiedTab(worktreeId, 'terminal', {
    id: `unified-${tabId}`,
    entityId: tabId,
    ...(targetGroupId ? { targetGroupId } : {})
  })
  const ptyId = `pty-${tabId}`
  const s = store.getState()
  store.setState({
    tabsByWorktree: {
      ...s.tabsByWorktree,
      [worktreeId]: [
        ...(s.tabsByWorktree[worktreeId] ?? []),
        makeTab({ id: tabId, worktreeId, ptyId })
      ]
    },
    ptyIdsByTabId: { ...s.ptyIdsByTabId, [tabId]: [ptyId] },
    terminalLayoutsByTabId: {
      ...s.terminalLayoutsByTabId,
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    }
  })
  return { worktreeId, tabId, paneKey: `${tabId}:${leafId}` }
}

const shortId = (id: string): string =>
  id.replace('repo1::/path/', '').replace(LEAF_1, 'L1').replace(LEAF_2, 'L2')

const markers = (record: Record<string, unknown>): string =>
  Object.entries(record)
    .map(([key, reason]) => `${shortId(key)}=${String(reason)}`)
    .join(' ') || '-'

// dockCount stays unexported; check-focus-read-ratchet counts exported readers named observe.
const dockCount = (s: AppState): number => createUnreadBadgeCountSelector()(s)

/** One compact line per observable, so a scenario step reads as a diffable block. */
export function observe(store: AttentionStore, persists: () => PersistCall[]): string[] {
  const s = store.getState()
  resetFloatingWorkspaceUnreadSelectorCacheForTest()
  const rows = Object.values(s.worktreesByRepo)
    .flat()
    .map(
      (w) =>
        `${shortId(w.id)}@${w.hostId ?? 'local'}:${w.isUnread ? 'UNREAD' : 'read'}:${w.lastActivityAt}`
    )
  const folders = s.folderWorkspaces.map(
    (f) =>
      `${f.id}@${f.executionHostId ?? f.connectionId ?? 'local'}:${f.isUnread ? 'UNREAD' : 'read'}:${f.lastActivityAt}`
  )
  return [
    `rows ${[...rows, ...folders].join(' ')} sortEpoch=${s.sortEpoch}`,
    `tabs ${markers(s.unreadTerminalTabs)}`,
    `panes ${markers(s.unreadTerminalPanes)}`,
    `completions ${markers(s.unreadAgentCompletionPanes)}`,
    `dock=${dockCount(s)} floatingDot=${selectFloatingWorkspaceHasUnread(s)}`,
    ...persists().map(
      (call) =>
        `persist ${call.kind} ${shortId(call.id)} ${JSON.stringify(call.updates)}${
          call.executionHostId ? ` host=${call.executionHostId}` : ''
        }`
    )
  ]
}
