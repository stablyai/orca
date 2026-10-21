import React from 'react'
import { CircleDot, ExternalLink, GitMerge, GitPullRequest, Link2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import {
  workspaceAttachmentLabel,
  workspaceAttachmentProviderLabel
} from './worktree-attachment-editing'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'
import {
  IssueStateBadge,
  LinearStateBadge,
  ReviewChecksBadge,
  ReviewStateBadge
} from './WorktreeCardMetadataStatusBadges'
import { WorkspaceAttachmentOrigins } from './WorkspaceAttachmentOrigins'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'
import type { WorkspaceReferenceDetailsMap } from './workspace-reference-details'
import { getWorkspaceHoverAttachments } from './workspace-hover-attachments'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardJiraIssueDisplay
} from './worktree-card-meta-types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export function WorktreeCardLinkedItemsSection({
  workspace,
  referenceDetails,
  review,
  issue,
  linearIssue,
  jiraIssue,
  showItems,
  onManage,
  onOpen
}: {
  workspace?: Worktree
  referenceDetails?: WorkspaceReferenceDetailsMap
  review: WorktreeCardPrDisplay | null
  issue?: WorktreeCardIssueDisplay | null
  linearIssue?: WorktreeCardLinearIssueDisplay | null
  jiraIssue?: WorktreeCardJiraIssueDisplay | null
  showItems: boolean
  onManage?: (event: React.MouseEvent) => void
  onOpen?: (url: string) => void
}): React.JSX.Element | null {
  if (!workspace) {
    return null
  }
  const { items, activeKey, referenceKeys } = getWorkspaceHoverAttachments(workspace, {
    review,
    issue,
    linearIssue,
    jiraIssue
  })
  const groups = [
    {
      label: translate('workspace.links.reviews', 'Reviews'),
      items: items.filter((item) => item.type !== 'issue')
    },
    {
      label: translate('workspace.links.tasks', 'Issues & tasks'),
      items: items.filter((item) => item.type === 'issue')
    }
  ].filter((group) => group.items.length)
  const open = (item: WorkspaceAttachment, event: React.MouseEvent): void => {
    event.stopPropagation()
    if (item.url) {
      if (onOpen) {
        onOpen(item.url)
      } else {
        void window.api.shell.openUrl(item.url)
      }
    } else {
      onManage?.(event)
    }
  }
  return (
    <WorktreeCardDetailSection data-workspace-hover-linked-items="">
      {showItems
        ? groups.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <DetailHeader
                icon={<Link2 className="size-3" />}
                label={`${group.label} · ${group.items.length}`}
              />
              <div className="divide-y divide-border">
                {group.items.map((item) => {
                  const key = getWorkspaceAttachmentKey(item)
                  const label = workspaceAttachmentLabel(item)
                  const source = getWorkspaceAttachmentSourceLabel(item)
                  const active = key === activeKey
                  const detail = referenceDetails?.[referenceKeys[items.indexOf(item)]]
                  const url = item.url || detail?.url
                  const live =
                    detail?.review ??
                    (active &&
                    review?.provider === item.provider &&
                    review.number === item.number &&
                    (!item.url || review.url === item.url)
                      ? review
                      : null)
                  return (
                    <div
                      key={key}
                      className="space-y-1 py-1.5"
                      data-workspace-hover-reference={key}
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        {live ? (
                          <ReviewIcon review={live} className="mt-0.5 size-3.5 shrink-0" />
                        ) : item.type === 'mr' ? (
                          <GitMerge className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        ) : item.type === 'pr' ? (
                          <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <CircleDot className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <button
                          type="button"
                          className="min-w-0 flex-1 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={!url && !onManage}
                          aria-label={translate('workspace.links.openItem', 'Open {{label}}', {
                            label
                          })}
                          onClick={(event) => open({ ...item, url }, event)}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <p className="line-clamp-2 text-xs font-medium leading-snug">
                            {detail?.title || item.title || (live?.url ? live.title : label)}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {label} · {workspaceAttachmentProviderLabel(item)}
                            {source ? ` · ${source}` : ''}
                          </p>
                        </button>
                        {url ? (
                          <ExternalLink
                            aria-hidden
                            className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                      </div>
                      {live?.state || live?.status || detail?.stateName || detail?.issueState ? (
                        <div className="flex flex-wrap items-center gap-1 pl-5">
                          {live?.state ? (
                            <ReviewStateBadge state={live.state} label={getReviewLabel(live)} />
                          ) : null}
                          {live?.status ? <ReviewChecksBadge status={live.status} /> : null}
                          {detail?.stale ? (
                            <span className="text-[11px] text-muted-foreground">
                              {translate('workspace.links.lastKnownStatus', 'Last known status')}
                            </span>
                          ) : null}
                          {live && 'baseRefName' in live && live.baseRefName ? (
                            <span className="text-[11px] text-muted-foreground">
                              {translate('workspace.links.reviewTarget', 'Target: {{branch}}', {
                                branch: live.baseRefName
                              })}
                            </span>
                          ) : null}
                          {detail?.stateName ? (
                            <LinearStateBadge
                              stateName={detail.stateName}
                              stateType={detail.stateType}
                            />
                          ) : null}
                          {detail?.issueState ? (
                            <IssueStateBadge state={detail.issueState} />
                          ) : null}
                        </div>
                      ) : null}
                      {item.origins?.length ? (
                        <WorkspaceAttachmentOrigins item={item} workspace={workspace} />
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        : null}
      {onManage ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onManage}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Plus />
          {items.length
            ? translate('workspace.links.manage', 'Manage links…')
            : translate('workspace.links.addReference', 'Add reference')}
        </Button>
      ) : null}
    </WorktreeCardDetailSection>
  )
}
