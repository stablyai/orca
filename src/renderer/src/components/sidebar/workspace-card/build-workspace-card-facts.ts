import { getWorkspaceAttachments } from '../../../../../shared/workspace-attachments'
import type { WorktreeCardProperty } from '../../../../../shared/ui-chrome-types'
import type {
  WorkspaceCardFacts,
  WorkspaceCardShowOptions
} from '../../../../../shared/workspace-cards/workspace-card-facts'
import type { WorktreeCardController } from '../use-worktree-card-controller'

const showOptionsCache = new WeakMap<readonly WorktreeCardProperty[], WorkspaceCardShowOptions>()

// Why cached: every card shares one properties array, so the toggles are built once per change.
function showOptions(cardProps: readonly WorktreeCardProperty[]): WorkspaceCardShowOptions {
  const cached = showOptionsCache.get(cardProps)
  if (cached) {
    return cached
  }
  const has = (property: WorktreeCardProperty): boolean => cardProps.includes(property)
  const show: WorkspaceCardShowOptions = {
    status: has('status'),
    unread: has('unread'),
    ci: has('ci'),
    branch: has('branch'),
    issue: has('issue'),
    linearIssue: has('linear-issue'),
    jiraIssue: has('jira-issue'),
    pr: has('pr'),
    automation: has('automation'),
    cli: has('cli'),
    comment: has('comment'),
    ports: has('ports'),
    inlineAgents: has('inline-agents'),
    host: has('host')
  }
  showOptionsCache.set(cardProps, show)
  return show
}

/** The person's card settings as facts; shared by live cards and previews. */
export function workspaceCardOptionFacts(input: {
  newCardStyle: boolean
  compactCards: boolean
  cardProps: readonly WorktreeCardProperty[]
  agentActivityDisplayMode: string | undefined
}): WorkspaceCardFacts['options'] {
  return {
    style: input.newCardStyle ? 'new' : input.compactCards ? 'compact' : 'classic',
    show: showOptions(input.cardProps),
    agentRows: input.agentActivityDisplayMode === 'compact' ? 'compact' : 'full'
  }
}

/** Projects the card controller into the documented fact model a template reads. */
const NO_CARD_OPTIONS: WorkspaceCardFacts['cardOptions'] = {}

export function buildWorkspaceCardFacts(
  card: WorktreeCardController,
  cardOptions: WorkspaceCardFacts['cardOptions'] = NO_CARD_OPTIONS
): WorkspaceCardFacts {
  const { worktree, repo, hoverReview } = card
  const runtimeHost = !repo?.connectionId && card.parsedRepoHost?.kind === 'runtime'
  return {
    ws: {
      id: worktree.id,
      name: worktree.displayName,
      title: card.visibleCardTitle,
      kind: card.isFolder ? 'folder' : 'git',
      path: worktree.path,
      branch: card.branch,
      identity: card.identityDisplay ?? null,
      isMain: worktree.isMainWorktree,
      isSparse: worktree.isSparse === true,
      detachedHead: card.detachedHeadDisplay !== null,
      isPinned: worktree.isPinned,
      isUnread: worktree.isUnread,
      isDeleting: card.isDeleting,
      isRenaming: card.titleRenaming,
      hasRenameError:
        typeof worktree.firstAgentMessageRenameError === 'string' &&
        worktree.firstAgentMessageRenameError.length > 0,
      removalError: worktree.removalError || null,
      comment: worktree.comment
    },
    repo: repo ? { id: repo.id, name: repo.displayName, ssh: Boolean(repo.connectionId) } : null,
    host: {
      kind: repo?.connectionId ? 'ssh' : runtimeHost ? 'runtime' : 'local',
      contextLabel: card.hostContextLabel || null,
      runtimeDisconnected: card.isRuntimeDisconnected
    },
    git: {
      conflictOperation: card.conflictOperation ?? null,
      remoteBranchConflict: card.remoteBranchConflict
        ? {
            remote: card.remoteBranchConflict.remote,
            branch: card.remoteBranchConflict.branchName
          }
        : null,
      cacheTimerActive: card.cacheStartedAt != null
    },
    review: hoverReview
      ? {
          provider: hoverReview.provider,
          number: hoverReview.number,
          title: hoverReview.title,
          state: hoverReview.state ?? null,
          status: hoverReview.status ?? null,
          url: hoverReview.url ?? null
        }
      : null,
    checks: {
      total: card.reviewChecks.total,
      passing: card.reviewChecks.passed,
      failing: card.reviewChecks.failed,
      pending: card.reviewChecks.pending
    },
    links: {
      count: getWorkspaceAttachments(worktree).length,
      issue: Boolean(card.hoverIssue),
      linearIssue: Boolean(card.hoverLinearIssue),
      jiraIssue: Boolean(card.hoverJiraIssue)
    },
    provenance: {
      automation: Boolean(worktree.automationProvenance),
      cli: Boolean(worktree.cliProvenance)
    },
    ports: { count: card.workspacePorts.length },
    lineage: {
      childCount: card.lineageChildCount,
      collapsed: card.lineageCollapsed,
      toggleable: card.showLineageChildChip
    },
    place: {
      isActive: card.isActive,
      inPinnedSection: card.inPinnedSection,
      hideRepoBadge: card.hideRepoBadge === true,
      showProjectName: card.showProjectName === true,
      affiliateList: card.affiliateListMode,
      deleteQuickAction: card.showDeleteQuickAction
    },
    options: workspaceCardOptionFacts(card),
    env: { projectGroups: card.projectGroups.length > 0 },
    cardOptions
  }
}
