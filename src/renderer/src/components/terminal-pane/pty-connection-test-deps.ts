import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { PtyTransport } from './pty-transport-types'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import { createPane, leafIdForPane } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

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
  paneKittyKeyboardModesRef: { current: Map<number, TerminalKittyKeyboardModeTracker> }
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
  markTerminalBell: Mock
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
    markTerminalBell: vi.fn(),
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

export async function createTypedPaneConnectionFixture(getState: () => StoreState) {
  const [{ Terminal }, { PaneManager }, { FitAddon }, { SearchAddon }, { SerializeAddon }] =
    await Promise.all([
      import('@xterm/xterm'),
      import('@/lib/pane-manager/pane-manager'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-search'),
      import('@xterm/addon-serialize')
    ])
  const originalPane = createPane(1)
  const leafId = originalPane.leafId
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Expected a terminal leaf UUID')
  }
  const terminal = new Terminal({ cols: 120, rows: 40, ...originalPane.terminal.options })
  vi.spyOn(terminal, 'element', 'get').mockReturnValue(originalPane.container)
  vi.spyOn(terminal, 'write').mockImplementation(function write(data, callback) {
    if (data === '' || callback?.name === 'runParsedSteps') {
      callback?.()
    }
  })
  const fitAddon = vi.mockObject(FitAddon.prototype)
  fitAddon.proposeDimensions.mockReturnValue({ cols: terminal.cols, rows: terminal.rows })
  const pane: ManagedPane = {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal,
    container: originalPane.container,
    linkTooltip: originalPane.container,
    fitAddon,
    searchAddon: vi.mockObject(SearchAddon.prototype),
    serializeAddon: vi.mockObject(SerializeAddon.prototype)
  }
  const manager = vi.mockObject(PaneManager.prototype)
  manager.getPanes.mockReturnValue([pane])
  manager.getActivePane.mockReturnValue(null)
  manager.hasWebglRenderer.mockReturnValue(false)
  manager.getNumericIdForLeaf.mockImplementation((candidate) => (candidate === leafId ? 1 : null))
  manager.getLeafId.mockImplementation((id) => (id === 1 ? leafId : null))
  const originalDeps = buildPaneConnectionDeps(getState)
  const deps = {
    ...originalDeps,
    paneTransportsRef: { current: new Map<number, PtyTransport>() },
    paneMode2031Ref: { current: new Map<number, boolean>() },
    paneLastThemeModeRef: {
      current: new Map<number, TerminalColorSchemeMode>()
    },
    replayingPanesRef: { current: new Map<number, number>() },
    syncPanePtyLayoutBinding: vi.fn((paneId: number, ptyId: string | null) => {
      const layout = getState().terminalLayoutsByTabId?.['tab-1']
      if (layout?.ptyIdsByLeafId && ptyId === null) {
        delete layout.ptyIdsByLeafId[leafIdForPane(paneId)]
      } else if (ptyId !== null) {
        originalDeps.syncPanePtyLayoutBinding(paneId, ptyId)
      }
    })
  } satisfies PtyConnectionDeps
  return { pane, manager, deps }
}
