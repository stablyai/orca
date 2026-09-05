import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import type { SidebarHostOption } from '@/components/sidebar/sidebar-host-options'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import { buildWorktreePaletteDocuments } from '@/lib/worktree-palette-document'
import { resolvePaletteRepoForWorktree } from '@/lib/palette-repo-resolution'
import type { PaletteDocument } from '@/lib/palette-match/palette-document'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

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
    const badge = getPaletteHostBadge(repo, hostOptions, hostFilterActive)
    if (badge) {
      hostLabelByWorktreeId.set(getWorktreeHostIdentity(worktree), badge.label)
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
