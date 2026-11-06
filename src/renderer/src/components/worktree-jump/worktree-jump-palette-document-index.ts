import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import type { SidebarHostOption } from '@/components/sidebar/worktree-list/controls/sidebar-host-options'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-ports/workspace-port-groups'
import { buildWorktreePaletteDocuments } from '@/lib/workspace/search/worktrees/worktree-palette-document'
import {
  getPaletteWorktreeIdentity,
  getPaletteWorktreeExecutionHostId,
  resolvePaletteRepoForWorktree
} from '@/lib/workspace/search/palette-repo-resolution'
import type { PaletteDocument } from '../../../../shared/palette-match/palette-document'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import type { HostedReviewInfo } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

export function buildWorktreeJumpPaletteDocumentIndex({
  worktrees,
  repoMap,
  repoByHostIdentity,
  hostOptions,
  hostFilterActive,
  prCache,
  issueCache,
  workspacePortScan,
  checksReviewByWorktree
}: {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
  repoByHostIdentity: ReadonlyMap<string, Repo>
  hostOptions: readonly SidebarHostOption[]
  hostFilterActive: boolean
  prCache: AppState['prCache'] | null
  issueCache: AppState['issueCache'] | null
  workspacePortScan: WorkspacePortScanResult | null
  checksReviewByWorktree: ReadonlyMap<Worktree, HostedReviewInfo | null>
}): Map<string, PaletteDocument> {
  const hostLabelByWorktreeId = new Map<string, string>()
  for (const worktree of worktrees) {
    const repo = resolvePaletteRepoForWorktree(worktree, repoMap, repoByHostIdentity)
    const badge = getPaletteHostBadge(
      getPaletteWorktreeExecutionHostId(worktree) ?? (repo && getRepoExecutionHostId(repo)),
      hostOptions,
      hostFilterActive
    )
    if (badge) {
      hostLabelByWorktreeId.set(getPaletteWorktreeIdentity(worktree), badge.label)
    }
  }
  return buildWorktreePaletteDocuments(
    worktrees.filter((worktree) => !worktree.isArchived),
    {
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      prCache,
      issueCache,
      workspacePortsByWorktreeId: getWorkspacePortsByWorktreeId(workspacePortScan),
      checksReviewByWorktree,
      hostLabelByWorktreeId
    }
  )
}
