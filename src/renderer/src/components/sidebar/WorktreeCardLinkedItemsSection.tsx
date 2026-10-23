import React from 'react'
import { Link2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import {
  workspaceAttachmentLabel,
  workspaceAttachmentProviderLabel
} from './worktree-attachment-editing'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'
import { IssueStateBadge, LinearStateBadge } from './WorktreeCardMetadataStatusBadges'
import { WorkspaceAttachmentOrigins } from './WorkspaceAttachmentOrigins'
import { WorktreeCardReferenceRow } from './WorktreeCardReferenceRow'
import type { WorkspaceReferenceDetailsMap } from './workspace-reference-details'
import { getWorkspaceLinkedItemRows } from './workspace-hover-attachments'
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
  onOpen,
  renderReviewActions
}: {
  workspace?: Worktree
  referenceDetails?: WorkspaceReferenceDetailsMap
  review: WorktreeCardPrDisplay | null
  issue?: WorktreeCardIssueDisplay | null
  linearIssue?: WorktreeCardLinearIssueDisplay | null
  jiraIssue?: WorktreeCardJiraIssueDisplay | null
  showItems: boolean
  onManage?: (event: React.MouseEvent) => void
  onOpen?: (url: string, event: React.MouseEvent) => void
  renderReviewActions?: (
    item: WorkspaceAttachment,
    review: WorktreeCardPrDisplay | null
  ) => React.ReactNode
}): React.JSX.Element | null {
  if (!workspace) {
    return null
  }
  const rows = getWorkspaceLinkedItemRows(
    workspace,
    { review, issue, linearIssue, jiraIssue },
    referenceDetails
  )
  const groups = [
    {
      label: translate('workspace.links.reviews', 'Reviews'),
      rows: rows.filter((row) => row.item.type !== 'issue')
    },
    {
      label: translate('workspace.links.tasks', 'Issues & tasks'),
      rows: rows.filter((row) => row.item.type === 'issue')
    }
  ].filter((group) => group.rows.length)
  if (!showItems && (rows.length > 0 || review || issue || linearIssue || jiraIssue || !onManage)) {
    return null
  }
  const open = (item: WorkspaceAttachment, event: React.MouseEvent): void => {
    event.stopPropagation()
    if (item.url) {
      if (onOpen) {
        onOpen(item.url, event)
      } else {
        event.preventDefault()
        void window.api.shell.openUrl(item.url)
      }
    } else {
      event.preventDefault()
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
                label={`${group.label} · ${group.rows.length}`}
                onAddReference={onManage}
              />
              <div className="divide-y divide-border">
                {group.rows.map(({ item, key, url, detail, live }) => {
                  const label = workspaceAttachmentLabel(item)
                  const source = getWorkspaceAttachmentSourceLabel(item)
                  return (
                    <div
                      key={key}
                      className="space-y-1 py-1.5"
                      data-workspace-hover-reference={key}
                    >
                      <WorktreeCardReferenceRow
                        review={live}
                        kind={item.type}
                        title={detail?.title || item.title || (live?.url ? live.title : label)}
                        label={label}
                        provider={workspaceAttachmentProviderLabel(item)}
                        source={source}
                        url={url}
                        onOpen={(url, event) => open({ ...item, url }, event)}
                        onManage={onManage ? (event) => open(item, event) : undefined}
                        actions={
                          item.type !== 'issue' ? renderReviewActions?.(item, live) : undefined
                        }
                      />
                      {detail?.stale ||
                      (live && 'baseRefName' in live && live.baseRefName) ||
                      detail?.stateName ||
                      detail?.issueState ? (
                        <div className="flex flex-wrap items-center gap-1 pl-5">
                          {detail?.stale ? (
                            <span className="text-2xs text-muted-foreground">
                              {translate('workspace.links.lastKnownStatus', 'Last known status')}
                            </span>
                          ) : null}
                          {live && 'baseRefName' in live && live.baseRefName ? (
                            <span className="text-2xs text-muted-foreground">
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
      {!rows.length && onManage ? (
        <DetailHeader
          icon={<Link2 className="size-3" />}
          label={translate('workspace.links.title', 'Linked work')}
          onAddReference={onManage}
        />
      ) : null}
    </WorktreeCardDetailSection>
  )
}
