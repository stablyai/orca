import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { MatchRange } from '../../../shared/palette-match/normalized-text'
import type {
  PaletteDocument,
  PaletteDocumentRank
} from '../../../shared/palette-match/palette-document'
import type { PaletteResultQualityClass } from '../../../shared/palette-match/match-quality'
import type { PaletteActivityRank } from '../../../shared/palette-match/palette-ranking'

export type SearchableSimulatorTab = {
  tab: Tab
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  /** Normalized field index, built once per entry rather than per keystroke. */
  document: PaletteDocument
}

export type SimulatorPaletteSearchResult = {
  /** Worktree ids collide across hosts; activation must not resolve by id alone. */
  executionHostId?: ExecutionHostId
  paletteIdentity: string
  tabId: string
  worktreeId: string
  groupId: string
  title: string
  secondaryText: string
  secondaryMatches: readonly { text: string; ranges: readonly MatchRange[] }[]
  repoName: string
  worktreeName: string
  branchName: string
  titleRanges: readonly MatchRange[]
  secondaryRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  worktreeRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  typeAliasMatch?: { text: string; ranges: readonly MatchRange[] } | null
  typeAliasMatches: readonly { text: string; ranges: readonly MatchRange[] }[]
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  score: number
  qualityClass: PaletteResultQualityClass | null
  rank: PaletteDocumentRank | null
  lastActiveAt?: number | null
  activity: PaletteActivityRank
}

export type BuildSearchableSimulatorTabsOptions = {
  worktrees: readonly Worktree[]
  ownershipWorktrees?: readonly Pick<Worktree, 'id'>[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  repoMapByHostIdentity?: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: WorkspaceVisibleTabType
}
