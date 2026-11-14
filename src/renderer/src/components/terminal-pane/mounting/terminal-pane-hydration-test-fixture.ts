import { Terminal } from '@xterm/headless'
import { vi, type Mock } from 'vitest'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../shared/workspace-layout/terminal-tab-types'
import { mintStablePaneId } from '@/lib/pane-manager/pane-layout/mint-stable-pane-id'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'

export const FIRST_LEAF = '11111111-1111-4111-8111-111111111111'
export const SECOND_LEAF = '22222222-2222-4222-8222-222222222222'
export const FIRST_REF = `v1-${'a'.repeat(32)}`
export const SECOND_REF = `v1-${'b'.repeat(32)}`
export const NEW_REF = `v1-${'c'.repeat(32)}`

export class HeadlessMountManager {
  static instances: HeadlessMountManager[] = []
  panes: { id: number; leafId: string; terminal: Terminal; container: HTMLDivElement }[] = []
  activeId = 1
  constructor(readonly container: HTMLDivElement) {
    HeadlessMountManager.instances.push(this)
  }
  createInitialPane({ leafId }: { leafId: string }) {
    const pane = {
      id: this.panes.length + 1,
      leafId,
      terminal: new Terminal({ cols: 80, rows: 6, allowProposedApi: true }),
      container: document.createElement('div')
    }
    pane.container.className = 'pane'
    pane.container.dataset.leafId = leafId
    this.panes.push(pane)
    this.container.append(pane.container)
    return pane
  }
  splitPane(id: number, direction: string, options?: { leafId: string }) {
    const existing = this.panes.find((pane) => pane.id === id)!
    const split = document.createElement('div')
    split.className = `pane-split ${direction === 'horizontal' ? 'is-horizontal' : ''}`
    existing.container.replaceWith(split)
    const next = this.createInitialPane({ leafId: options?.leafId ?? mintStablePaneId() })
    split.append(existing.container, next.container)
    return next
  }
  getLeafIdMap() {
    return new Map(this.panes.map((pane) => [pane.id, pane.leafId]))
  }
  getPanes() {
    return this.panes
  }
  getActivePane() {
    return this.panes.find((pane) => pane.id === this.activeId)
  }
  getNumericIdForLeaf(leafId: string) {
    return this.panes.find((pane) => pane.leafId === leafId)?.id ?? null
  }
  setActivePane(id: number) {
    this.activeId = id
  }
  hasWebglRenderer() {
    return true
  }
  setTerminalGpuAcceleration() {}
  fitAllPanes() {}
  destroy() {
    for (const pane of this.panes) {
      pane.terminal.dispose()
      pane.container.remove()
    }
    this.container.replaceChildren()
  }
}

export function mountDeps(): UseTerminalPaneLifecycleDeps {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/first',
    consumeTabIssueCommandSplit: vi.fn(),
    isActive: false,
    isVisible: true,
    settings: null,
    settingsRef: { current: null },
    systemPrefersDark: false,
    requestOpenLinksInAppPreference: vi.fn(),
    requestTerminalLinkAction: vi.fn(),
    effectiveMacOptionAsAlt: 'false',
    effectiveMacOptionAsAltRef: { current: 'false' },
    clearedScrollbackLeafIdsRef: { current: new Set() },
    initialLayoutRef: { current: { root: null, activeLeafId: null, expandedLeafId: null } },
    managerRef: { current: null },
    containerRef: { current: document.createElement('div') },
    getTabWideAgentHintLeafId: () => null,
    expandedStyleSnapshotRef: { current: new Map() },
    paneTransportsRef: { current: new Map() },
    panePtyBindingsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    paneMode2031Ref: { current: new Map() },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: false },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: () => false,
    isPtyShutdownPending: () => false,
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn(),
    markTerminalBell: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
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
  }
}

export async function parsedRows(manager: HeadlessMountManager): Promise<string[]> {
  return Promise.all(
    manager.panes.map(async ({ terminal }) => {
      await new Promise<void>((resolve) => terminal.write('', resolve))
      const buffer = terminal.buffer.active
      return Array.from(
        { length: buffer.length },
        (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
      ).join('\n')
    })
  )
}

export type TerminalPaneHydrationFixtureState = {
  deps: UseTerminalPaneLifecycleDeps | null
  reads: Mock<(ref: string) => Promise<string | null>>
  store: {
    tabsByWorktree: Record<string, TerminalTab[]>
    terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
    localOnlyScrollbackByTabId: Record<string, Record<string, string>>
    repos: never[]
    allWorktrees: () => never[]
    consumeTabInitialCwd: () => null
    setTabLayout: Mock<(tabId: string, layout: TerminalLayoutSnapshot) => void>
    setTabLocalOnlyScrollback: Mock
    consumeSuppressedPtyExit: () => boolean
    isPtyShutdownPending: () => boolean
  }
}
