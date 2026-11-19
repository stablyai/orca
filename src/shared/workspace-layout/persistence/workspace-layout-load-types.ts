import type { ExecutionHostId } from '../../execution-host/execution-host'
import type { TerminalLayoutSnapshot } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'
import type {
  CarriedSessionFields,
  DesktopLayoutView,
  FactSessionField,
  LayoutContentFacts
} from './workspace-layout-beside'
import type { LayoutLoadChange } from './workspace-layout-load-report'
import type { LayoutEditorView } from '../editor-tabs/layout-editor-view'
import type { WorkspaceLayoutModel } from '../workspace-layout-model'

export type WorkspaceLayoutLoadContext = {
  /** Mint missing or repeated group/tab IDs from a partition-unique seed identifying what they replace. */
  mintId: (seed: string) => string
  /** Mint UUID pane IDs for repeated IDs or legacy one-pane rows, using the same seed convention. */
  mintLeafId: (seed: string) => string
  /** A live pane's binding generation (main's, in memory); absent when the context has none. */
  ptyGenerationOf?: (leafId: string) => number | undefined
  /** A workspace's editor tab views (main's, in memory: never saved); absent when it has none. */
  editorViewsOf?: (workspaceKey: string) => Readonly<Record<string, LayoutEditorView>> | undefined
}

export type LoadedWorkspaceLayout = {
  layout: WorkspaceLayoutModel
  desktopView: DesktopLayoutView
  facts: LayoutContentFacts
  carried: CarriedSessionFields
}

/** What partition readers use; a partly reloaded partition holds no save inputs or partition-wide facts. */
export type LoadedWorkspaceLayoutRead = Pick<LoadedWorkspaceLayout, 'desktopView'> & {
  layout: Pick<WorkspaceLayoutModel, 'hostId' | 'workspaces'>
  facts: Omit<LayoutContentFacts, FactSessionField>
}

export type WorkspaceLayoutLoadResult = LoadedWorkspaceLayout & {
  /** Every on-disk value the next save writes differently from what was loaded. */
  changes: LayoutLoadChange[]
}

export type WorkspaceLoadArgs = {
  session: WorkspaceSessionState
  hostId: ExecutionHostId
  key: string
  /** Terminal tab id → the one workspace that keeps its row. */
  terminalHomes: ReadonlyMap<string, string>
  context: WorkspaceLayoutLoadContext
  view: DesktopLayoutView
  facts: LayoutContentFacts
  /** Terminal tab id → its stored pane layout (a legacy row's built one). */
  layouts: Map<string, TerminalLayoutSnapshot>
  /** A dropped row's id → the tab-bar terminal that holds its terminals. */
  canonicalTabIdBySubsumedTabId: { set(tabId: string, canonicalTabId: string): void }
}
