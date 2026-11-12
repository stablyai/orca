import React, { useCallback } from 'react'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { buildWorkspaceAttachmentEdits } from '../metadata/worktree-attachment-editing'
import type { WorktreeCardPrDisplay } from '../review/worktree-card-pr-display'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { toast } from 'sonner'

import type { GitHubWorkItem } from '../../../../../../shared/github/work-item-types'
import { translate } from '@/i18n/i18n'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import './WorktreeCardMeta'
import { hasWorktreeCardDetails } from '../metadata/WorktreeCardMetaBadges'
import { usePromptCacheCountdownStartedAt } from '../activity/CacheTimer'
import { useWorktreeAgentKeys } from '../activity/useWorktreeAgentRows'
import type { WorktreeCardSecondaryDetailsInputs } from './worktree-card-secondary-details-inputs'

export function useWorktreeCardSecondaryDetails({
  worktree,
  repo,
  statusPrDisplay,
  showStatus,
  showIssue,
  showLinearIssue,
  showJiraIssue,
  showPR,
  showAutomation,
  showCli,
  showComment,
  showPorts,
  issueDisplay,
  linearIssue,
  linearIssueDisplay,
  jiraIssueDisplay,
  prDisplay,
  linkedGitLabMR,
  linkedBitbucketPR,
  linkedAzureDevOpsPR,
  linkedGiteaPR,
  newCardStyle,
  compactCards,
  cardDetails,
  agentActivityDisplayMode,
  workspacePorts,
  openTaskPage,
  updateWorktreeMeta,
  settings
}: WorktreeCardSecondaryDetailsInputs) {
  // Why: unread lives in the left status lane, so the Status toggle owns both the dot/PR slot and unread emphasis.
  const showUnreadEmphasis = showStatus && worktree.isUnread
  const hoverIssue = issueDisplay
  const hoverLinearIssue = linearIssueDisplay
  const hoverJiraIssue = jiraIssueDisplay
  const hoverReview = prDisplay
  const statusLaneReview = statusPrDisplay ?? hoverReview
  const hoverComment = worktree.comment
  const metaIssue = showIssue ? hoverIssue : null
  const metaLinearIssue = showLinearIssue ? hoverLinearIssue : null
  const metaJiraIssue = showJiraIssue ? hoverJiraIssue : null
  const metaReview = showPR ? hoverReview : null
  const metaAutomationProvenance = showAutomation ? worktree.automationProvenance : null
  const metaCliProvenance = showCli ? worktree.cliProvenance : null
  const metaComment = showComment ? hoverComment : null
  const showInlineAgentList = cardDetails.inlineAgents
  const compactInlineAgentKeys = useWorktreeAgentKeys(
    worktree.id,
    showInlineAgentList && agentActivityDisplayMode === 'compact'
  )
  const compactInlineAgentRowsVisible =
    showInlineAgentList &&
    agentActivityDisplayMode === 'compact' &&
    compactInlineAgentKeys.length > 0
  const showAggregateCacheTimer = !compactCards && !compactInlineAgentRowsVisible
  const handleOpenGitHubIssueInOrca = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const issueUrl = hoverIssue && 'url' in hoverIssue ? hoverIssue.url : undefined
      if (!repo || !hoverIssue || !issueUrl) {
        return
      }
      const item: GitHubWorkItem = {
        id: issueUrl,
        type: 'issue',
        number: hoverIssue.number,
        title: hoverIssue.title,
        state: 'state' in hoverIssue ? (hoverIssue.state ?? 'open') : 'open',
        url: issueUrl,
        labels: 'labels' in hoverIssue ? (hoverIssue.labels ?? []) : [],
        updatedAt: new Date().toISOString(),
        author: null,
        repoId: repo.id
      }
      openTaskPage({ taskSource: 'github', preselectedRepoId: repo.id, openGitHubWorkItem: item })
    },
    [hoverIssue, openTaskPage, repo]
  )
  const handleOpenReviewInOrca = useCallback(
    (e: React.MouseEvent, review: WorktreeCardPrDisplay | null = hoverReview) => {
      e.stopPropagation()
      if (!repo || !review?.url || review.provider !== 'github') {
        return
      }
      const item: GitHubWorkItem = {
        id: review.url,
        type: 'pr',
        number: review.number,
        title: review.title,
        state: review.state ?? 'open',
        url: review.url,
        labels: [],
        updatedAt: 'updatedAt' in review ? review.updatedAt : new Date().toISOString(),
        author: null,
        headSha: 'headSha' in review ? review.headSha : undefined,
        repoId: repo.id
      }
      openTaskPage({ taskSource: 'github', preselectedRepoId: repo.id, openGitHubWorkItem: item })
    },
    [hoverReview, openTaskPage, repo]
  )
  const openLinkedUrlInBrowser = useCallback(
    (url: string): void => {
      void openWorkspaceBrowserTab({
        workspaceId: worktree.id,
        url,
        intent: { kind: 'url' }
      }).catch((error: unknown) => {
        toast.error(
          error instanceof Error
            ? error.message
            : translate('auto.lib.workspace.browser.tab.open.urlFailed', 'Unable to open URL.')
        )
      })
    },
    [worktree.id]
  )
  const handleOpenIssueInBrowser = useCallback(
    (url: string): void => {
      openLinkedUrlInBrowser(url)
    },
    [openLinkedUrlInBrowser]
  )
  const handleOpenReviewInBrowser = useCallback(
    (url: string): void => {
      openLinkedUrlInBrowser(url)
    },
    [openLinkedUrlInBrowser]
  )
  const hoverReviewProvider = hoverReview?.provider
  const canUnlinkReview =
    hoverReviewProvider === 'github' ||
    (hoverReviewProvider === 'gitlab' && linkedGitLabMR !== null) ||
    (hoverReviewProvider === 'bitbucket' && linkedBitbucketPR !== null) ||
    (hoverReviewProvider === 'azure-devops' && linkedAzureDevOpsPR !== null) ||
    (hoverReviewProvider === 'gitea' && linkedGiteaPR !== null)
  const hasExplicitLinkedReview =
    (hoverReviewProvider === 'github' && worktree.linkedPR !== null) ||
    (hoverReviewProvider === 'gitlab' && linkedGitLabMR !== null) ||
    (hoverReviewProvider === 'bitbucket' && linkedBitbucketPR !== null) ||
    (hoverReviewProvider === 'azure-devops' && linkedAzureDevOpsPR !== null) ||
    (hoverReviewProvider === 'gitea' && linkedGiteaPR !== null)
  const handleUnlinkReview = useCallback(
    async (item?: WorkspaceAttachment) => {
      const options = { executionHostId: worktree.hostId ?? 'local' }
      if (item) {
        const initial = getWorkspaceAttachments(worktree)
        const key = getWorkspaceAttachmentKey(item)
        const draft = initial.filter((entry) => getWorkspaceAttachmentKey(entry) !== key)
        const result = await updateWorktreeMeta(
          worktree.id,
          {
            ...buildWorkspaceAttachmentEdits({ initial, draft }),
            ...(item.provider === 'github' &&
            hoverReview?.provider === 'github' &&
            hoverReview.number === item.number &&
            (!item.url || item.url === hoverReview.url)
              ? { suppressedGitHubPR: item.number }
              : {})
          },
          options
        )
        if (!result.ok) {
          toast.error(result.error)
        }
        return
      }
      switch (hoverReviewProvider) {
        case 'github':
          if (hoverReview) {
            const result = await updateWorktreeMeta(
              worktree.id,
              { linkedPR: null, suppressedGitHubPR: hoverReview.number },
              options
            )
            if (!result.ok) {
              toast.error(result.error)
            }
          }
          return
        case 'gitlab':
          void updateWorktreeMeta(worktree.id, { linkedGitLabMR: null }, options)
          return
        case 'bitbucket':
          void updateWorktreeMeta(worktree.id, { linkedBitbucketPR: null }, options)
          return
        case 'azure-devops':
          void updateWorktreeMeta(worktree.id, { linkedAzureDevOpsPR: null }, options)
          return
        case 'gitea':
          void updateWorktreeMeta(worktree.id, { linkedGiteaPR: null }, options)
          break
        case 'unsupported':
        case undefined:
          break
      }
    },
    [hoverReview, hoverReviewProvider, updateWorktreeMeta, worktree]
  )
  const handleOpenLinearIssueInOrca = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!linearIssue) {
        return
      }
      openTaskPage({ taskSource: 'linear', openLinearIssue: linearIssue })
    },
    [linearIssue, openTaskPage]
  )
  const hasDetails =
    getWorkspaceAttachments(worktree).length > 0 ||
    hasWorktreeCardDetails({
      issue: metaIssue,
      linearIssue: metaLinearIssue,
      jiraIssue: metaJiraIssue,
      review: newCardStyle ? null : metaReview,
      comment: metaComment,
      automationProvenance: metaAutomationProvenance,
      cliProvenance: metaCliProvenance
    })
  const hasPorts = showPorts && workspacePorts.length > 0
  const cacheStartedAt = usePromptCacheCountdownStartedAt(worktree.id, showAggregateCacheTimer)
  // Reuse subscribed card settings to avoid another per-card listener on every store write.
  const cacheTtlMs = showAggregateCacheTimer ? (settings?.promptCacheTtlMs ?? 0) : 0

  return {
    showUnreadEmphasis,
    hoverIssue,
    hoverLinearIssue,
    hoverJiraIssue,
    hoverReview,
    statusLaneReview,
    hoverComment,
    metaIssue,
    metaLinearIssue,
    metaJiraIssue,
    metaReview,
    metaAutomationProvenance,
    metaCliProvenance,
    metaComment,
    showInlineAgentList,
    compactInlineAgentKeys,
    handleOpenGitHubIssueInOrca,
    handleOpenIssueInBrowser,
    handleOpenReviewInOrca,
    canUnlinkReview,
    handleOpenReviewInBrowser,
    hasExplicitLinkedReview,
    handleUnlinkReview,
    handleOpenLinearIssueInOrca,
    hasDetails,
    hasPorts,
    cacheStartedAt,
    cacheTtlMs
  }
}
