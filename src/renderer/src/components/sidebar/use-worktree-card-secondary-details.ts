import React, { useCallback } from 'react'
import { toast } from 'sonner'

import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { translate } from '@/i18n/i18n'
import { openWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-open'
import { hasWorktreeCardDetails } from './WorktreeCardMeta'
import { usePromptCacheCountdownStartedAt } from './CacheTimer'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import type { WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import type { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'
import type { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type LinkedDetails = ReturnType<typeof useWorktreeCardLinkedDetails>
type ReviewDetails = ReturnType<typeof useWorktreeCardReviewDetails>

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
  cardProps,
  newCardStyle,
  compactCards,
  agentActivityDisplayMode,
  workspacePorts,
  openTaskPage,
  updateWorktreeMeta,
  settings
}: Pick<WorktreeCardProps, 'worktree' | 'repo' | 'statusPrDisplay'> &
  Pick<
    Foundation,
    | 'cardProps'
    | 'newCardStyle'
    | 'compactCards'
    | 'agentActivityDisplayMode'
    | 'workspacePorts'
    | 'openTaskPage'
    | 'updateWorktreeMeta'
    | 'settings'
  > &
  Pick<LinkedDetails, 'issueDisplay' | 'linearIssue' | 'linearIssueDisplay' | 'jiraIssueDisplay'> &
  Pick<
    ReviewDetails,
    'prDisplay' | 'linkedGitLabMR' | 'linkedBitbucketPR' | 'linkedAzureDevOpsPR' | 'linkedGiteaPR'
  > & {
    showStatus: boolean
    showIssue: boolean
    showLinearIssue: boolean
    showJiraIssue: boolean
    showPR: boolean
    showAutomation: boolean
    showCli: boolean
    showComment: boolean
    showPorts: boolean
  }) {
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
  const showInlineAgentList = cardProps.includes('inline-agents') && (newCardStyle || !compactCards)
  const compactInlineAgentRows = useWorktreeAgentRows(
    worktree.id,
    showInlineAgentList && agentActivityDisplayMode === 'compact'
  )
  const compactInlineAgentRowsVisible =
    showInlineAgentList &&
    agentActivityDisplayMode === 'compact' &&
    compactInlineAgentRows.length > 0
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
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!repo || !hoverReview?.url || hoverReview.provider !== 'github') {
        return
      }
      const item: GitHubWorkItem = {
        id: hoverReview.url,
        type: 'pr',
        number: hoverReview.number,
        title: hoverReview.title,
        state: hoverReview.state ?? 'open',
        url: hoverReview.url,
        labels: [],
        updatedAt: 'updatedAt' in hoverReview ? hoverReview.updatedAt : new Date().toISOString(),
        author: null,
        headSha: 'headSha' in hoverReview ? hoverReview.headSha : undefined,
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
  const handleUnlinkReview = useCallback(async () => {
    const options = { executionHostId: worktree.hostId ?? 'local' }
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
  }, [hoverReview, hoverReviewProvider, updateWorktreeMeta, worktree.hostId, worktree.id])
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
  const hasDetails = hasWorktreeCardDetails({
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
  // Why: derived from the settings the card already subscribes to — a third store
  // subscription for this one field costs a listener per card on every store write.
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
    compactInlineAgentRows,
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
