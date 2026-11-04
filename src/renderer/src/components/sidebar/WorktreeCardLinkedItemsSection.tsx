import React from 'react'
import { GitPullRequest, Link2, ListTodo } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import {
  workspaceAttachmentLabel,
  workspaceAttachmentProviderLabel
} from './worktree-attachment-editing'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'
import {
  getIssueTaskState,
  getLinearTaskState,
  type WorktreeTaskState
} from './worktree-task-state'
import { WorkspaceAttachmentOrigins } from './WorkspaceAttachmentOrigins'
import { WorktreeCardReferenceRow } from './WorktreeCardReferenceRow'
import { WorktreeCardTaskActions } from './WorktreeCardTaskDetailSection'
import type { WorktreeCardTaskActionHandlers } from './worktree-card-task-actions'
import type {
  WorkspaceReferenceDetails,
  WorkspaceReferenceDetailsMap
} from './workspace-reference-details'
import {
  getWorkspaceLinkedItemRows,
  type WorkspaceLinkedItemRow
} from './workspace-hover-attachments'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardLinearIssueDisplay,
  WorktreeCardJiraIssueDisplay
} from './worktree-card-meta-types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { openAppHttpLink } from '@/lib/app-http-link-open'

function getLinkedTaskState(
  detail: WorkspaceReferenceDetails | undefined,
  liveTask: WorkspaceLinkedItemRow['liveTask']
): WorktreeTaskState | null {
  if (detail?.stateName) {
    return getLinearTaskState(detail.stateName, detail.stateType)
  }
  if (detail?.issueState) {
    return getIssueTaskState(detail.issueState)
  }
  if (liveTask && 'identifier' in liveTask) {
    return getLinearTaskState(liveTask.stateName, liveTask.stateType)
  }
  return getIssueTaskState(liveTask?.state)
}

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
  renderReviewActions,
  taskMenu
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
  taskMenu?: { actions: WorktreeCardTaskActionHandlers; onOpenChange: (open: boolean) => void }
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
      icon: <GitPullRequest className="size-3" />,
      rows: rows.filter((row) => row.item.type !== 'issue')
    },
    {
      label: translate('workspace.links.tasks', 'Issues & tasks'),
      icon: <ListTodo className="size-3" />,
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
        openAppHttpLink(item.url, { worktreeId: workspace.id, event })
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
                icon={group.icon}
                label={`${group.label} · ${group.rows.length}`}
                onAddReference={onManage}
              />
              <div className="divide-y divide-border">
                {group.rows.map(({ item, key, url, detail, live, liveTask }) => {
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
                        stale={detail?.stale}
                        taskState={
                          item.type === 'issue' ? getLinkedTaskState(detail, liveTask) : null
                        }
                        labels={liveTask?.labels}
                        url={url}
                        onOpen={(url, event) => open({ ...item, url }, event)}
                        onManage={onManage ? (event) => open(item, event) : undefined}
                        origins={
                          item.origins?.length ? (
                            <WorkspaceAttachmentOrigins item={item} workspace={workspace} compact />
                          ) : undefined
                        }
                        actions={
                          item.type === 'issue'
                            ? taskMenu && (
                                <WorktreeCardTaskActions
                                  item={item}
                                  url={url}
                                  isCardTask={Boolean(liveTask)}
                                  actions={taskMenu.actions}
                                  onOpenChange={taskMenu.onOpenChange}
                                />
                              )
                            : renderReviewActions?.(item, live)
                        }
                      />
                      {live && 'baseRefName' in live && live.baseRefName ? (
                        <div className="pl-5 text-2xs text-muted-foreground">
                          {translate('workspace.links.reviewTarget', 'Target: {{branch}}', {
                            branch: live.baseRefName
                          })}
                        </div>
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
