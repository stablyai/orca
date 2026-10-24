import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { PtyTransport } from './pty-transport-types'
import type { PtyPaneStartup } from './pty-connection-types'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import { leafIdForPane } from './pty-connection-test-pane-fixtures'
import type { AgentStatusReadState } from '@/store/agent-status-observers'
import type { AgentStatusPatch } from '@/store/agent-status-patch'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

type MockRef = { current: Mock }

/** Index signature carries the untyped `overrides` spread the specs pass in. */
export type PaneConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd: string
  cwdPromise?: Promise<string>
  startup: PtyPaneStartup
  restoredLeafId: string | null
  restoredPtyIdByLeafId: Record<string, string>
  mountFollowsTerminalPark: boolean
  paneTransportsRef: { current: Map<number, PtyTransport> }
  paneMode2031Ref: { current: Map<number, boolean> }
  paneKittyKeyboardModesRef: { current: Map<number, TerminalKittyKeyboardModeTracker> }
  paneLastThemeModeRef: { current: Map<number, TerminalColorSchemeMode> }
  replayingPanesRef: { current: Map<number, number> }
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
  markTerminalBell: Mock
  dispatchNotification: Mock
  onShowSessionRestoredBanner: Mock
  setCacheTimerStartedAt: Mock
  syncPanePtyLayoutBinding: Mock<(paneId: number, ptyId: string | null) => void>
  clearExitedPanePtyLayoutBinding: Mock
  [key: string]: unknown
}

export function buildPaneConnectionDeps(
  fixture: { read: () => AgentStatusReadState; patch: (patch: AgentStatusPatch) => void },
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
      const current = fixture.read().ptyIdsByTabId?.[tabId] ?? []
      const next =
        replacedPtyId && current.includes(replacedPtyId)
          ? current.map((candidate) => (candidate === replacedPtyId ? ptyId : candidate))
          : current.includes(ptyId)
            ? current
            : [...current, ptyId]
      fixture.patch({ ptyIdsByTabId: { ...fixture.read().ptyIdsByTabId, [tabId]: next } })
    }),
    markTerminalBell: vi.fn(),
    dispatchNotification: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn((paneId: number, ptyId: string | null) => {
      const layout = fixture.read().terminalLayoutsByTabId?.['tab-1']
      if (layout) {
        const bindings = { ...layout.ptyIdsByLeafId }
        if (ptyId === null) {
          delete bindings[leafIdForPane(paneId)]
        } else {
          bindings[leafIdForPane(paneId)] = ptyId
        }
        layout.ptyIdsByLeafId = bindings
      }
    }),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}
