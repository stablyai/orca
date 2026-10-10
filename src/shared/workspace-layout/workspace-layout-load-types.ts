import type { ExecutionHostId } from '../execution-host'
import type { TerminalLayoutSnapshot } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type {
  CarriedSessionFields,
  DesktopLayoutView,
  LayoutContentFacts
} from './workspace-layout-beside'
import type { LayoutLoadChange } from './workspace-layout-load-report'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

export type WorkspaceLayoutLoadContext = {
  /**
   * Mints ids for groups and tabs the stored data lacks or repeats. `seed` names what the id
   * stands in for, unique in the partition, so a context may derive the id from it.
   */
  mintId: (seed: string) => string
  /** Mints pane ids (UUIDs) for a repeated pane id or a legacy row's one pane; `seed` as above. */
  mintLeafId: (seed: string) => string
}

/** A stored session partition, split into the layout and what is kept beside it. */
export type LoadedWorkspaceLayout = {
  layout: WorkspaceLayoutModel
  desktopView: DesktopLayoutView
  facts: LayoutContentFacts
  carried: CarriedSessionFields
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
}
