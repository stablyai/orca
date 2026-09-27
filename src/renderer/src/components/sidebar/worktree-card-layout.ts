import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { WorktreeCardProps } from './worktree-card-model'

export function selectWorktreeCardIdentity({
  worktree,
  repo,
  newCardStyle,
  cardProps,
  hasProjectGroups
}: Pick<WorktreeCardProps, 'worktree' | 'repo'> & {
  newCardStyle: boolean
  cardProps: readonly WorktreeCardProperty[]
  hasProjectGroups: boolean
}) {
  const gitIdentityDisplay = getWorktreeGitIdentityDisplay(worktree)
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const isFolder = repo ? isFolderRepo(repo) : folderWorkspaceId !== null
  const branchIdentityDisplay = !isFolder && branch.length > 0 ? branch : undefined
  const folderPathIdentityDisplay =
    isFolder && hasProjectGroups && worktree.path.trim().length > 0 ? worktree.path : undefined
  const identityDisplay = branchIdentityDisplay ?? folderPathIdentityDisplay
  const hasPathIdentityEnabled = cardProps.includes('branch')
  const showIdentityInNewCard = newCardStyle && hasPathIdentityEnabled && Boolean(identityDisplay)
  const folderMetaRowContent = newCardStyle
    ? hasPathIdentityEnabled && Boolean(folderPathIdentityDisplay)
    : isFolder
  return {
    detachedHeadDisplay,
    branch,
    folderWorkspaceId,
    isFolder,
    branchIdentityDisplay,
    folderPathIdentityDisplay,
    identityDisplay,
    showIdentityInNewCard,
    folderMetaRowContent
  }
}

export function selectWorktreeCardDisplayMode(
  newCardStyle: boolean,
  compactPreference: boolean,
  cardProps: readonly WorktreeCardProperty[]
) {
  const compactCards = !newCardStyle && compactPreference
  return {
    compactCards,
    showInlineAgentList: cardProps.includes('inline-agents') && (newCardStyle || !compactCards)
  }
}

export function hasWorktreeLineageChildChip(count: number, toggleAvailable: boolean): boolean {
  return count > 0 && toggleAvailable
}

export function selectWorktreeCardLayout(input: {
  newCardStyle: boolean
  compactCards: boolean
  hasRepo: boolean
  inPinnedSection: boolean
  hideRepoBadge: boolean
  hostContextLabel?: string
  isFolder: boolean
  detachedHead: boolean
  branch: string
  displayName: string
  folderMetaRowContent: boolean
  showIdentityInNewCard: boolean
  conflictOperation: string | null | undefined
  cacheVisible: boolean
  hasDetails: boolean
  hasPorts: boolean
  showInlineAgentList: boolean
  showLineageChildChip: boolean
  hasRemoteBranchConflict: boolean
}) {
  const showPinnedRepoIcon = input.inPinnedSection && input.hasRepo
  const showRepoIdentityInTitle = input.newCardStyle || input.compactCards
  const showInlineRepoBadge =
    showRepoIdentityInTitle &&
    input.hasRepo &&
    !input.hideRepoBadge &&
    !input.isFolder &&
    !showPinnedRepoIcon
  const showRepoBadgeInMetaRow =
    !showRepoIdentityInTitle && input.hasRepo && !input.hideRepoBadge && !showPinnedRepoIcon
  const showHostContextBadge = !input.compactCards && !!input.hostContextLabel
  const showDetachedHeadInMetaRow = !input.compactCards && !input.isFolder && input.detachedHead
  const showBranch =
    !input.isFolder &&
    input.branch.length > 0 &&
    !input.newCardStyle &&
    (!input.compactCards || input.branch !== input.displayName)
  const showConflictOperationBadge =
    !!input.conflictOperation &&
    input.conflictOperation !== 'unknown' &&
    input.conflictOperation !== 'rebase'
  const showMetaRowDetails =
    !input.newCardStyle && !input.compactCards && (input.hasDetails || input.hasPorts)
  const showTitleRowIndicators =
    (input.newCardStyle || input.compactCards) && (input.hasDetails || input.hasPorts)
  const hasDetailedMetaRowContent =
    showRepoBadgeInMetaRow ||
    showHostContextBadge ||
    input.folderMetaRowContent ||
    showBranch ||
    input.showIdentityInNewCard ||
    showDetachedHeadInMetaRow ||
    showConflictOperationBadge ||
    input.cacheVisible ||
    showMetaRowDetails
  const hasMetaRow = input.compactCards
    ? showConflictOperationBadge || input.cacheVisible
    : hasDetailedMetaRowContent
  const titleOnlyCard = !(
    hasMetaRow ||
    input.hasRemoteBranchConflict ||
    input.showInlineAgentList ||
    input.showLineageChildChip
  )
  return {
    showPinnedRepoIcon,
    showInlineRepoBadge,
    showRepoBadgeInMetaRow,
    showHostContextBadge,
    showDetachedHeadInMetaRow,
    showBranch,
    showConflictOperationBadge,
    showMetaRowDetails,
    showTitleRowIndicators,
    hasMetaRow,
    titleOnlyCard
  }
}
