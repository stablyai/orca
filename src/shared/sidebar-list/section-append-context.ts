import type {
  WorktreeGroupBy,
  Row,
  RepoOfWorktree,
  PendingCreationRef,
  NewExternalWorktreesInboxCandidate,
  ImportedWorktreesCardCandidate
} from './row-types'

import type { ProjectGroupingIndex } from '../project-section-grouping'
import type { NoticeHostContext } from './host-labels'
import type { ExecutionHostId } from '../execution-host'
import type { Worktree, WorkspaceStatusDefinition } from '../worktree/types'

import type { WorktreeOccurrencePlan } from '../worktree-occurrence-plan'
import type { Repo } from '../repo-types'
/** Everything section emission reads that stays fixed for one planSidebarRows call. */
export type SectionAppendContext = {
  result: Row[]
  groupBy: WorktreeGroupBy
  collapsedGroups: Set<string>
  workspaceStatusById?: ReadonlyMap<string, WorkspaceStatusDefinition>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  repoMap: Map<string, Repo>
  repoOf: RepoOfWorktree
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string> | undefined
  projectIndex: ProjectGroupingIndex | null
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  repoByHost?: ReadonlyMap<string, Repo>
  pendingByRepo: ReadonlyMap<string, PendingCreationRef[]>
  mixedWorktreeHostContextLabels: Map<string, string> | undefined
  noticeHostContextLabelByRepoId: Map<string, NoticeHostContext> | undefined
  occurrencePlan: WorktreeOccurrencePlan<Worktree>
}
