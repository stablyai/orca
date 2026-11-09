import type { Repo } from '../../../../shared/repository/repo-types'
import { sanitizeRepoIcon } from '../../../../shared/repository/appearance/repo-icon'
import { normalizeRepoBadgeColor } from '../../../../shared/repository/appearance/repo-badge-color'
import { normalizeGhAccountBinding } from '../../../../shared/github/accounts/account-binding'
import { normalizeJiraProjectReference } from '../../../../shared/jira/jira-project-reference'
import { sanitizeAgentWorkspaceTrustDecision } from '../../../../shared/agent-launch/permissions/agent-workspace-trust-decision'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../../shared/worktree/visibility/visibility-sources'
import type { RepoUpdate } from './repo-state'

export function sanitizeRepoUpdate(updates: RepoUpdate): RepoUpdate {
  const sanitized = { ...updates }
  if ('defaultJiraProject' in sanitized) {
    const reference = normalizeJiraProjectReference(sanitized.defaultJiraProject)
    if (reference === undefined) {
      delete sanitized.defaultJiraProject
    } else {
      sanitized.defaultJiraProject = reference
    }
  }
  if ('badgeColor' in sanitized) {
    const badgeColor = normalizeRepoBadgeColor(sanitized.badgeColor)
    if (!badgeColor) {
      delete sanitized.badgeColor
    } else {
      sanitized.badgeColor = badgeColor
    }
  }
  if ('repoIcon' in sanitized) {
    const repoIcon = sanitizeRepoIcon(sanitized.repoIcon)
    if (repoIcon === undefined) {
      delete sanitized.repoIcon
    } else {
      sanitized.repoIcon = repoIcon
    }
  }
  if ('worktreeBasePath' in sanitized && sanitized.worktreeBasePath !== undefined) {
    sanitized.worktreeBasePath = sanitized.worktreeBasePath.trim() || undefined
  }
  if (
    'forkSyncMode' in sanitized &&
    sanitized.forkSyncMode !== undefined &&
    sanitized.forkSyncMode !== 'ask' &&
    sanitized.forkSyncMode !== 'safe-auto' &&
    sanitized.forkSyncMode !== 'off'
  ) {
    delete sanitized.forkSyncMode
  }
  if (
    'agentWorkspaceTrust' in sanitized &&
    sanitizeAgentWorkspaceTrustDecision(sanitized.agentWorkspaceTrust) === undefined
  ) {
    delete sanitized.agentWorkspaceTrust
  }
  if ('ghAccount' in sanitized && sanitized.ghAccount != null) {
    const normalized = normalizeGhAccountBinding(sanitized.ghAccount)
    if (!normalized) {
      delete sanitized.ghAccount
    } else {
      sanitized.ghAccount = normalized
    }
  }
  if ('customWorktreeVisibilitySources' in sanitized) {
    const sources = normalizeCustomWorktreeVisibilitySources(
      sanitized.customWorktreeVisibilitySources
    )
    if (!sources) {
      delete sanitized.customWorktreeVisibilitySources
    } else {
      sanitized.customWorktreeVisibilitySources = sources
    }
  }
  if ('worktreeVisibilitySourcePreferences' in sanitized) {
    const preferences = normalizeWorktreeVisibilitySourcePreferences(
      sanitized.worktreeVisibilitySourcePreferences
    )
    if (!preferences) {
      delete sanitized.worktreeVisibilitySourcePreferences
    } else {
      sanitized.worktreeVisibilitySourcePreferences = preferences
    }
  }
  return sanitized
}

export function applySanitizedRepoUpdateFallback(repo: Repo, sanitizedUpdates: RepoUpdate): Repo {
  let mergedRepo: Repo = repo
  const {
    projectGroupOrder: _projectGroupOrder,
    sourceControlAi,
    externalWorktreeDiscoverySuppressedAt,
    hiddenAt,
    ghAccount,
    externalWorktreeVisibility,
    agentWorktreeVisibility,
    workspaceCleanupPolicy,
    browserProfileId,
    ...updatesWithoutClearSentinels
  } = sanitizedUpdates
  mergedRepo = { ...mergedRepo, ...updatesWithoutClearSentinels }
  if (sourceControlAi === null) {
    const { sourceControlAi: _sourceControlAi, ...repoWithoutSourceControlAi } = mergedRepo
    mergedRepo = repoWithoutSourceControlAi
  } else if (sourceControlAi !== undefined) {
    mergedRepo = { ...mergedRepo, sourceControlAi }
  }
  if (externalWorktreeVisibility === null) {
    const { externalWorktreeVisibility: _visibility, ...repoWithoutVisibility } = mergedRepo
    mergedRepo = { ...repoWithoutVisibility, externalWorktreeVisibilityLegacy: false }
  } else if (externalWorktreeVisibility !== undefined) {
    mergedRepo = { ...mergedRepo, externalWorktreeVisibility }
  }
  if (agentWorktreeVisibility === null) {
    const { agentWorktreeVisibility: _agentVisibility, ...repoWithoutAgentVisibility } = mergedRepo
    mergedRepo = repoWithoutAgentVisibility
  } else if (agentWorktreeVisibility !== undefined) {
    mergedRepo = { ...mergedRepo, agentWorktreeVisibility }
  }
  if (externalWorktreeDiscoverySuppressedAt === null) {
    const { externalWorktreeDiscoverySuppressedAt: _suppressedAt, ...repoWithoutSuppression } =
      mergedRepo
    mergedRepo = repoWithoutSuppression
  } else if (externalWorktreeDiscoverySuppressedAt !== undefined) {
    mergedRepo = { ...mergedRepo, externalWorktreeDiscoverySuppressedAt }
  }
  if (hiddenAt === null) {
    const { hiddenAt: _hiddenAt, ...repoWithoutHiddenAt } = mergedRepo
    mergedRepo = repoWithoutHiddenAt
  } else if (hiddenAt !== undefined) {
    mergedRepo = { ...mergedRepo, hiddenAt }
  }
  if (ghAccount === null) {
    const { ghAccount: _ghAccount, ...repoWithoutGhAccount } = mergedRepo
    mergedRepo = repoWithoutGhAccount
  } else if (ghAccount !== undefined) {
    mergedRepo = { ...mergedRepo, ghAccount }
  }
  if (workspaceCleanupPolicy === null) {
    const { workspaceCleanupPolicy: _policy, ...repoWithoutCleanupPolicy } = mergedRepo
    mergedRepo = repoWithoutCleanupPolicy
  } else if (workspaceCleanupPolicy !== undefined) {
    mergedRepo = { ...mergedRepo, workspaceCleanupPolicy }
  }
  if (browserProfileId === null) {
    const { browserProfileId: _browserProfileId, ...repoWithoutBrowserProfile } = mergedRepo
    mergedRepo = repoWithoutBrowserProfile
  } else if (browserProfileId !== undefined) {
    mergedRepo = { ...mergedRepo, browserProfileId }
  }
  return mergedRepo
}
