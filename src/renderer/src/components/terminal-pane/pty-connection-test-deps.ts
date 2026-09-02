import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { leafIdForPane } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

type MockRef = { current: Mock }

/** Index signature carries the untyped `overrides` spread the specs pass in. */
export type PaneConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd: string
  startup: null
  restoredLeafId: string | null
  restoredPtyIdByLeafId: Record<string, string>
  mountFollowsTerminalPark: boolean
  paneTransportsRef: { current: Map<number, unknown> }
  paneMode2031Ref: { current: Map<number, unknown> }
  paneKittyKeyboardModesRef: { current: Map<number, unknown> }
  paneLastThemeModeRef: { current: Map<number, unknown> }
  replayingPanesRef: { current: Map<number, unknown> }
  isActiveRef: { current: boolean }
  isVisibleRef: { current: boolean }
  onPtyExitRef: MockRef
  onAgentExitedRef: MockRef
  onPtyErrorRef: MockRef
  clearTabPtyId: Mock
  consumeSuppressedPtyExit: Mock<() => boolean>
  isPtyShutdownPending: Mock<() => boolean>
  updateTabTitle: Mock
  setRuntimePaneTitle: Mock
  clearRuntimePaneTitle: Mock
  updateTabPtyId: Mock<(tabId: string, ptyId: string, replacedPtyId?: string) => void>
  markWorktreeUnread: Mock
  markTerminalTabUnread: Mock
  markTerminalPaneUnread: Mock
  clearWorktreeUnread: Mock
  clearTerminalTabUnread: Mock
  clearTerminalPaneUnread: Mock
  dispatchNotification: Mock
  onShowSessionRestoredBanner: Mock
  setCacheTimerStartedAt: Mock
  syncPanePtyLayoutBinding: Mock<(paneId: number, ptyId: string) => void>
  clearExitedPanePtyLayoutBinding: Mock
  [key: string]: unknown
}

export function buildPaneConnectionDeps(
  getState: () => StoreState,
  overrides: Record<string, unknown> = {}
): PaneConnectionDeps {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/wt-1',
    startup: null,
    restoredLeafId: null,
    restoredPtyIdByLeafId: {},
    mountFollowsTerminalPark: false,
    paneTransportsRef: { current: new Map() },
    paneMode2031Ref: { current: new Map() },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    isPtyShutdownPending: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn((tabId: string, ptyId: string, replacedPtyId?: string) => {
      const current = getState().ptyIdsByTabId?.[tabId] ?? []
      const next =
        replacedPtyId && current.includes(replacedPtyId)
          ? current.map((candidate) => (candidate === replacedPtyId ? ptyId : candidate))
          : current.includes(ptyId)
            ? current
            : [...current, ptyId]
      getState().ptyIdsByTabId = { ...getState().ptyIdsByTabId, [tabId]: next }
    }),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    clearTerminalTabUnread: vi.fn(),
    clearTerminalPaneUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn((paneId: number, ptyId: string) => {
      const layout = getState().terminalLayoutsByTabId?.['tab-1']
      if (layout) {
        layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [leafIdForPane(paneId)]: ptyId }
      }
    }),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

export type DirectSshSplitRetryCommit = Mock<
  (tabId: string, ptyId: string, replacedPtyId?: string, directSshRetryAttemptId?: string) => void
>

export function buildDirectSshSplitRetryCommit(
  getState: () => StoreState
): DirectSshSplitRetryCommit {
  return vi.fn(
    (tabId: string, ptyId: string, _replacedPtyId?: string, directSshRetryAttemptId?: string) => {
      const currentPtyIds = getState().ptyIdsByTabId?.[tabId] ?? []
      getState().ptyIdsByTabId = {
        ...getState().ptyIdsByTabId,
        [tabId]: currentPtyIds.includes(ptyId) ? currentPtyIds : [...currentPtyIds, ptyId]
      }
      const pending = getState().directSshPaneRetryByTabId?.[tabId]
      if (!pending || pending.attemptId !== directSshRetryAttemptId) {
        return
      }
      const tab = getState().tabsByWorktree['wt-1'].find((candidate) => candidate.id === tabId)
      if (tab && !tab.ptyId) {
        tab.ptyId = ptyId
      }
      getState().directSshPaneRetryByTabId = {}
      getState().directSshLivePtyBindingByTabId = {
        [tabId]: {
          attemptId: pending.attemptId,
          authority: pending.authority,
          tabGeneration: pending.tabGeneration,
          ptyId: tab?.ptyId ?? ptyId
        }
      }
    }
  )
}
