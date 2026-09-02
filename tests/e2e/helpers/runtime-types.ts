import type { AppState } from '../../../src/renderer/src/store/types'
import type { OpenFile, RightSidebarTab } from '../../../src/renderer/src/store/slices/editor'
import type {
  ManagedPane,
  ManagedPaneInternal,
  PaneRenderingDiagnostics
} from '../../../src/renderer/src/lib/pane-manager/pane-manager-types'
import type { GlobalSettings } from '../../../src/shared/global-settings-types'
import type { BrowserWorkspace } from '../../../src/shared/browser-workspace-types'
import type { Repo } from '../../../src/shared/repo-types'
import type { WorkspaceVisibleTabType } from '../../../src/shared/tab-types'
import type { TerminalTab } from '../../../src/shared/terminal-tab-types'
import type { Worktree } from '../../../src/shared/worktree/types'
import type { DictationMeterState } from '../../../src/renderer/src/components/dictation/dictation-audio-meter'

// Why: window.__store is the Zustand bound store itself, so specs get the whole StoreApi.
export type AppStore = {
  getState(): AppState
  setState(partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void
  subscribe(listener: (state: AppState, previousState: AppState) => void): () => void
}

// Why: PaneManager hands out one object carrying both halves, and the rendering specs read
// the internal renderer state off it.
export type ManagedPaneHandle = ManagedPane & ManagedPaneInternal

// Why not optional: window.__paneManagers only ever holds real PaneManager instances, and
// marking the methods optional made every call site a possibly-undefined invocation.
export type PaneManagerLike = {
  getActivePane(): ManagedPaneHandle | null
  getPanes(limit?: number): ManagedPaneHandle[]
  splitPane(paneId: number, direction: 'vertical' | 'horizontal'): ManagedPaneHandle | null
  closePane(paneId: number): void
  setActivePane(paneId: number, opts?: { focus?: boolean }): void
  suspendRendering(): void
  resumeRendering(): void
  setTerminalGpuAcceleration(mode: GlobalSettings['terminalGpuAcceleration']): void
  getRenderingDiagnostics(): PaneRenderingDiagnostics[]
  resetWebglTextureAtlases(): void
  hasWebglRenderer(paneId: number): boolean
  getNumericIdForLeaf(leafId: string): number | null
}

export type ExplorerFileSummary = Pick<OpenFile, 'id' | 'filePath' | 'relativePath'>
export type BrowserTabSummary = Pick<BrowserWorkspace, 'id' | 'url' | 'title'>
export type TerminalTabSummary = Pick<TerminalTab, 'id' | 'title' | 'customTitle'>
export type SidebarStateSummary = {
  rightSidebarOpen: boolean
  rightSidebarTab: RightSidebarTab
}
export type TestRepoState = {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
}
export type TerminalViewState = {
  activeTabId: string | null
  activeTabType: WorkspaceVisibleTabType
  activeWorktreeId: string | null
  ptyIdsByTabId: Record<string, string[]>
  tabsByWorktree: Record<string, TerminalTab[]>
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __store?: AppStore
    __dictationMeterE2E?: { publish(meter: DictationMeterState): void }
    __paneManagers?: Map<string, PaneManagerLike>
  }
}

export function getWindowStore(): AppStore | null {
  return window.__store ?? null
}

export function getAppState(): AppState {
  const store = getWindowStore()
  if (!store) {
    throw new Error('window.__store is not available — is the app in dev mode?')
  }

  return store.getState()
}
