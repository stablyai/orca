import { vi } from 'vitest'
import type { PanePtyBinding } from './pty-connection/pane-pty-binding'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { TerminalPaneManagerOptionsContext } from './terminal-pane-mount-context'

export function createPaneManagerOptionsTestContext(
  ptyDeps: PtyConnectionDeps,
  binding: PanePtyBinding | null,
  startupCwd: string
): TerminalPaneManagerOptionsContext {
  return {
    deps: {
      ...ptyDeps,
      isActive: true,
      isVisible: true,
      systemPrefersDark: false,
      settings: null,
      settingsRef: { current: null },
      requestOpenLinksInAppPreference: vi.fn(),
      requestTerminalLinkAction: vi.fn(),
      effectiveMacOptionAsAlt: 'false',
      effectiveMacOptionAsAltRef: { current: 'false' },
      initialLayoutRef: {
        current: { root: null, activeLeafId: null, expandedLeafId: null, ptyIdsByLeafId: {} }
      },
      managerRef: { current: null },
      getTabWideAgentHintLeafId: () => null,
      containerRef: { current: null },
      expandedStyleSnapshotRef: { current: new Map() },
      paneFontSizesRef: { current: new Map() },
      paneCwdRef: { current: new Map() },
      panePtyBindingsRef: {
        current: new Map<number, PanePtyBinding>(binding ? [[1, binding]] : [])
      },
      dispatchNotification: vi.fn(),
      setTabPaneExpanded: vi.fn(),
      setTabCanExpandPane: vi.fn(),
      setExpandedPane: vi.fn(),
      syncExpandedLayout: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      showPaneTitle: vi.fn(),
      setPaneTitles: vi.fn(),
      paneTitlesRef: { current: {} },
      setRenamingPaneId: vi.fn(),
      setPaneCount: vi.fn(),
      setPaneLayoutRevision: vi.fn()
    },
    // Option construction captures these lifecycle-only values without reading them.
    get refs(): TerminalPaneManagerOptionsContext['refs'] {
      throw new Error('Lifecycle refs are outside the terminal-options refresh contract')
    },
    get linkDeps(): TerminalPaneManagerOptionsContext['linkDeps'] {
      throw new Error('Link handlers are outside the terminal-options refresh contract')
    },
    ptyDeps,
    deferredSplitHandoffs: new Map(),
    startupCwd,
    defaultTabCwd: startupCwd,
    worktreePath: startupCwd,
    terminalHomePath: null,
    wslDistro: null,
    fileOpenLinkHint: '',
    getPaneLinkCwd: () => startupCwd,
    getUrlOpenLinkHint: () => '',
    getHttpLinkSourceOwnerForPane: () => ({ kind: 'local' }),
    getHttpLinkActionDestinations: () => {
      throw new Error('Link destinations are outside the terminal-options refresh contract')
    },
    getLinkActionContext: () => null,
    canOpenOwnedBrowserForPane: () => false,
    requestOpenLinksInAppPreference: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    queueResizeAll: vi.fn(),
    syncPaneCount: vi.fn(),
    syncPaneLayoutRevision: vi.fn(),
    syncCanExpandState: vi.fn(),
    applyAppearance: vi.fn(),
    releaseWebviewDragPassthrough: { current: null },
    shouldPersistLayout: () => false,
    startup: ptyDeps.startup,
    osc7UncHost: null
  }
}
