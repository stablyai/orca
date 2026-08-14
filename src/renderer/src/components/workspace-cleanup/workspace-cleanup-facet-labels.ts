import { translate } from '@/i18n/i18n'
import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import type { WorkspaceCleanupTier } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupAgentState,
  WorkspaceCleanupBlockerMode,
  WorkspaceCleanupGitState,
  WorkspaceCleanupIdleSignal,
  WorkspaceCleanupPresence,
  WorkspaceCleanupReviewState,
  WorkspaceCleanupSortField,
  WorkspaceCleanupTicketSource,
  WorkspaceCleanupTriState
} from '../../../../shared/workspace-cleanup-filter-model'

export function getWorkspaceCleanupSortFieldLabel(field: WorkspaceCleanupSortField): string {
  switch (field) {
    case 'last-activity':
      return translate('components.workspace.cleanup.browse.sort.lastActivity', 'Last activity')
    case 'last-visited':
      return translate('components.workspace.cleanup.browse.sort.lastVisited', 'Last opened')
    case 'created':
      return translate('components.workspace.cleanup.browse.sort.created', 'Created')
    case 'size':
      return translate('components.workspace.cleanup.browse.sort.size', 'Size')
    case 'name':
      return translate('components.workspace.cleanup.browse.sort.name', 'Workspace')
    case 'repo':
      return translate('components.workspace.cleanup.browse.sort.repo', 'Repository')
    case 'path':
      return translate('components.workspace.cleanup.browse.sort.path', 'Path')
    case 'host':
      return translate('components.workspace.cleanup.browse.sort.host', 'Host')
    case 'workspace-status':
      return translate('components.workspace.cleanup.browse.sort.workspaceStatus', 'Status')
    case 'agent':
      return translate('components.workspace.cleanup.browse.sort.agent', 'Agent')
    case 'git':
      return translate('components.workspace.cleanup.browse.sort.git', 'Git')
    case 'ahead':
      return translate('components.workspace.cleanup.browse.sort.ahead', 'Ahead')
    case 'behind':
      return translate('components.workspace.cleanup.browse.sort.behind', 'Behind')
    case 'branch':
      return translate('components.workspace.cleanup.browse.sort.branch', 'Branch')
    case 'review':
      return translate('components.workspace.cleanup.browse.sort.review', 'Review')
    case 'ticket':
      return translate('components.workspace.cleanup.browse.sort.ticket', 'Ticket')
    case 'local-context':
      return translate('components.workspace.cleanup.browse.sort.localContext', 'Open context')
    case 'tier':
      return translate('components.workspace.cleanup.browse.sort.tier', 'Safety')
    case 'blocker-count':
      return translate('components.workspace.cleanup.browse.sort.blockerCount', 'Blockers')
  }
}

export function getWorkspaceCleanupGitStateLabel(state: WorkspaceCleanupGitState): string {
  switch (state) {
    case 'clean':
      return translate('components.workspace.cleanup.browse.git.clean', 'Clean')
    case 'dirty':
      return translate('components.workspace.cleanup.browse.git.dirty', 'Uncommitted changes')
    case 'unpushed':
      return translate('components.workspace.cleanup.browse.git.unpushed', 'Unpushed commits')
    case 'unknown':
      return translate('components.workspace.cleanup.browse.git.unknown', 'Not checked')
  }
}

export function getWorkspaceCleanupAgentStateLabel(state: WorkspaceCleanupAgentState): string {
  switch (state) {
    case 'working':
      return translate('components.workspace.cleanup.browse.agent.working', 'Working')
    case 'permission':
      return translate('components.workspace.cleanup.browse.agent.permission', 'Waiting on you')
    case 'idle':
      return translate('components.workspace.cleanup.browse.agent.idle', 'Idle')
  }
}

export function getWorkspaceCleanupReviewStateLabel(state: WorkspaceCleanupReviewState): string {
  switch (state) {
    case 'open':
      return translate('components.workspace.cleanup.browse.review.open', 'Open')
    case 'draft':
      return translate('components.workspace.cleanup.browse.review.draft', 'Draft')
    case 'merged':
      return translate('components.workspace.cleanup.browse.review.merged', 'Merged')
    case 'closed':
      return translate('components.workspace.cleanup.browse.review.closed', 'Closed')
    case 'unknown':
      return translate('components.workspace.cleanup.browse.review.unknown', 'Unknown')
  }
}

/** Provider-general: GitLab MRs and Azure DevOps PRs are first-class here. */
export function getWorkspaceCleanupReviewProviderLabel(provider: HostedReviewProvider): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'bitbucket':
      return 'Bitbucket'
    case 'azure-devops':
      return 'Azure DevOps'
    case 'gitea':
      return 'Gitea'
    case 'unsupported':
      return translate('components.workspace.cleanup.browse.review.otherProvider', 'Other')
  }
}

export function getWorkspaceCleanupTicketSourceLabel(source: WorkspaceCleanupTicketSource): string {
  switch (source) {
    case 'work-item':
      return translate('components.workspace.cleanup.browse.ticket.workItem', 'Work item')
    case 'linear':
      return translate('components.workspace.cleanup.browse.ticket.linear', 'Linear')
    case 'issue':
      return translate('components.workspace.cleanup.browse.ticket.issue', 'Issue')
  }
}

export function getWorkspaceCleanupTierLabel(tier: WorkspaceCleanupTier): string {
  switch (tier) {
    case 'ready':
      return translate('components.workspace.cleanup.browse.tier.ready', 'Ready')
    case 'review':
      return translate('components.workspace.cleanup.browse.tier.review', 'Needs review')
    case 'protected':
      return translate('components.workspace.cleanup.browse.tier.protected', 'Protected')
  }
}

export function getWorkspaceCleanupIdleSignalLabel(signal: WorkspaceCleanupIdleSignal): string {
  switch (signal) {
    case 'last-visited':
      return translate('components.workspace.cleanup.browse.idleSignal.lastVisited', 'Not opened')
    case 'last-activity':
      return translate('components.workspace.cleanup.browse.idleSignal.lastActivity', 'No activity')
    case 'created':
      return translate('components.workspace.cleanup.browse.idleSignal.created', 'Created before')
  }
}

export function getWorkspaceCleanupTriStateLabel(value: WorkspaceCleanupTriState): string {
  switch (value) {
    case 'any':
      return translate('components.workspace.cleanup.browse.triState.any', 'Any')
    case 'only':
      return translate('components.workspace.cleanup.browse.triState.only', 'Only')
    case 'exclude':
      return translate('components.workspace.cleanup.browse.triState.exclude', 'Exclude')
  }
}

export function getWorkspaceCleanupPresenceLabel(value: WorkspaceCleanupPresence): string {
  switch (value) {
    case 'any':
      return translate('components.workspace.cleanup.browse.presence.any', 'Any')
    case 'some':
      return translate('components.workspace.cleanup.browse.presence.some', 'Has one')
    case 'none':
      return translate('components.workspace.cleanup.browse.presence.none', 'Has none')
  }
}

export function getWorkspaceCleanupBlockerModeLabel(value: WorkspaceCleanupBlockerMode): string {
  return value === 'any-of'
    ? translate('components.workspace.cleanup.browse.blockerModeAny', 'Has any')
    : translate('components.workspace.cleanup.browse.blockerModeNone', 'Has none')
}
