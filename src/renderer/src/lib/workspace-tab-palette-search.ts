import type { OpenFile } from '@/store/slices/editor'
import type { PaletteDocument } from './palette-match/palette-document'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { Worktree } from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AgentMetadata, WorkspaceTabAgentMetadataState } from './workspace-tab-agent-metadata'
import { buildSearchableWorkspaceTabEntries } from './workspace-tab-palette-entry-builder'
export {
  searchWorkspaceTabs,
  type WorkspaceTabPaletteSearchResult
} from './workspace-tab-palette-results'

export type WorkspaceTabContentType =
  | 'terminal'
  | 'editor'
  | 'diff'
  | 'conflict-review'
  | 'check-details'

export type SearchableWorkspaceTab = {
  tab: Tab & { contentType: WorkspaceTabContentType }
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  groupSortIndex: number
  tabSortIndex: number
  title: string
  secondaryText: string
  titleSearchText: string
  secondarySearchTexts: string[]
  /**
   * Search-only type labels (e.g. "terminal tab"). Matched without writing into
   * the row secondary — the content icon already conveys type.
   */
  typeSearchAliases?: readonly string[]
  /** Normalized field index, built once per entry rather than per keystroke. */
  document: PaletteDocument
  agentMetadata: AgentMetadata[]
  /** Confident occupant for the row icon; null when the pane is a plain shell. */
  occupantAgent: TuiAgent | null
  isCurrentTab: boolean
  isCurrentWorktree: boolean
}

// Why search-only: the status/content icon already says "terminal"; a fixed
// secondary crowds the row. Keep these matchable so typing "terminal" still finds them.
export const TERMINAL_TYPE_SEARCH_ALIASES = ['terminal tab', 'terminal'] as const

type WorkspaceTabPaletteActiveTabType = 'browser' | 'editor' | 'terminal' | 'simulator'

export type BuildSearchableWorkspaceTabsOptions = WorkspaceTabAgentMetadataState & {
  worktrees: readonly Worktree[]
  ownershipWorktrees?: readonly Pick<Worktree, 'id'>[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  repoMapByHostIdentity?: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  tabsByWorktree: Record<string, readonly TerminalTab[] | undefined>
  openFiles: readonly OpenFile[]
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: WorkspaceTabPaletteActiveTabType
  activeTabId: string | null
  activeTabIdByWorktree: Record<string, string | null | undefined>
  activeFileId: string | null
  activeFileIdByWorktree: Record<string, string | null | undefined>
  activeTabTypeByWorktree: Record<string, WorkspaceTabPaletteActiveTabType | undefined>
  generatedTitlesEnabled: boolean
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  paneForegroundAgentByPaneKey?: Record<string, PaneForegroundAgentEntry>
}

export const buildSearchableWorkspaceTabs = buildSearchableWorkspaceTabEntries
