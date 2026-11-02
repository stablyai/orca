import type { MouseEvent } from 'react'
import { Copy, Globe, ListTodo, MonitorUp, Pencil } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'
import { WorktreeCardReferenceRow } from './WorktreeCardReferenceRow'
import { WorktreeCardRowActionsMenu } from './WorktreeCardRowActionsMenu'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'
import {
  workspaceAttachmentLabel,
  workspaceAttachmentProviderLabel
} from './worktree-attachment-editing'
import type { WorktreeCardTaskActionHandlers } from './worktree-card-task-actions'
import {
  getIssueTaskState,
  getLinearTaskState,
  type WorktreeTaskState
} from './worktree-task-state'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardJiraIssueDisplay,
  WorktreeCardLinearIssueDisplay
} from './worktree-card-meta-types'

type CardTask = {
  item: WorkspaceAttachment
  title: string
  state: WorktreeTaskState | null
  labels?: string[]
}

// Why: expressing the card's tasks as attachments shares labels, sources and menus with linked rows.
function getCardTasks(
  issue: WorktreeCardIssueDisplay | null | undefined,
  linearIssue: WorktreeCardLinearIssueDisplay | null | undefined,
  jiraIssue: WorktreeCardJiraIssueDisplay | null | undefined
): CardTask[] {
  const tasks: CardTask[] = []
  if (issue) {
    tasks.push({
      item: { provider: 'github', type: 'issue', number: issue.number, url: issue.url },
      title: issue.title,
      state: getIssueTaskState(issue.state),
      labels: issue.labels
    })
  }
  if (linearIssue) {
    tasks.push({
      item: {
        provider: 'linear',
        type: 'issue',
        number: 0,
        identifier: linearIssue.identifier,
        url: linearIssue.url
      },
      title: linearIssue.title,
      state: getLinearTaskState(linearIssue.stateName, linearIssue.stateType),
      labels: linearIssue.labels
    })
  }
  if (jiraIssue) {
    tasks.push({
      item: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        identifier: jiraIssue.identifier,
        url: jiraIssue.url
      },
      title: jiraIssue.title,
      state: null
    })
  }
  return tasks
}

export function WorktreeCardTaskActions({
  item,
  url,
  isCardTask,
  actions,
  onOpenChange
}: {
  item: WorkspaceAttachment
  url?: string
  /** Card-level actions only target the card's own issue or task. */
  isCardTask: boolean
  actions: WorktreeCardTaskActionHandlers
  onOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  const github = item.provider === 'github'
  const openInOrca = !isCardTask
    ? undefined
    : github
      ? actions.onOpenGitHubIssueInOrca
      : item.provider === 'linear'
        ? actions.onOpenLinearIssueInOrca
        : undefined
  const onEdit = isCardTask && github ? actions.onEditIssue : undefined
  const { onCopyLink, onOpenIssueInBrowser } = actions
  // Why: Copy link covers every row with a URL, so only URL-less, non-editable rows have no menu.
  if (!url && !onEdit) {
    return null
  }
  return (
    <WorktreeCardRowActionsMenu
      label={
        github
          ? translate(
              'auto.components.sidebar.WorktreeCardMeta.moreIssueActions',
              'More issue actions'
            )
          : translate(
              'auto.components.sidebar.WorktreeCardMeta.dbe2d18972',
              'More {{value0}} actions',
              { value0: workspaceAttachmentProviderLabel(item) }
            )
      }
      onOpenChange={onOpenChange}
    >
      {url && openInOrca ? (
        <DropdownMenuItem onClick={openInOrca}>
          <MonitorUp className="size-3.5" />
          {translate('auto.components.sidebar.WorktreeCardMeta.2c67730e07', 'Open in Orca')}
        </DropdownMenuItem>
      ) : null}
      {url && onOpenIssueInBrowser ? (
        <DropdownMenuItem onClick={() => onOpenIssueInBrowser(url)}>
          <Globe className="size-3.5" />
          {translate(
            'auto.components.sidebar.WorktreeCardMeta.openInOrcaBrowser',
            'Open in Orca browser'
          )}
        </DropdownMenuItem>
      ) : null}
      {onEdit ? (
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="size-3.5" />
          {translate('auto.components.sidebar.WorktreeCardMeta.807b13b9ec', 'Edit issue')}
        </DropdownMenuItem>
      ) : null}
      {url ? (
        <DropdownMenuItem onClick={() => onCopyLink(url)}>
          <Copy className="size-3.5" />
          {translate('auto.components.sidebar.WorktreeCardMeta.copyLink', 'Copy link')}
        </DropdownMenuItem>
      ) : null}
    </WorktreeCardRowActionsMenu>
  )
}

export function WorktreeCardTaskDetailSection({
  issue,
  linearIssue,
  jiraIssue,
  actions,
  onMenuOpenChange,
  onOpenLink,
  onManageLinks
}: {
  issue?: WorktreeCardIssueDisplay | null
  linearIssue?: WorktreeCardLinearIssueDisplay | null
  jiraIssue?: WorktreeCardJiraIssueDisplay | null
  actions: WorktreeCardTaskActionHandlers
  onMenuOpenChange: (open: boolean) => void
  onOpenLink: (url: string, event: MouseEvent) => void
  onManageLinks?: (event: MouseEvent) => void
}): React.JSX.Element | null {
  const tasks = getCardTasks(issue, linearIssue, jiraIssue)
  if (!tasks.length) {
    return null
  }
  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<ListTodo className="size-3" />}
        label={`${translate('workspace.links.tasks', 'Issues & tasks')} · ${tasks.length}`}
        onAddReference={onManageLinks}
      />
      <div className="divide-y divide-border">
        {tasks.map(({ item, title, state, labels }) => (
          <div key={item.provider} className="py-1.5">
            <WorktreeCardReferenceRow
              review={null}
              kind="issue"
              title={title}
              label={workspaceAttachmentLabel(item)}
              provider={workspaceAttachmentProviderLabel(item)}
              source={getWorkspaceAttachmentSourceLabel(item)}
              taskState={state}
              labels={labels}
              url={item.url}
              onOpen={onOpenLink}
              onManage={item.provider === 'github' ? actions.onEditIssue : undefined}
              actions={
                <WorktreeCardTaskActions
                  item={item}
                  url={item.url}
                  isCardTask
                  actions={actions}
                  onOpenChange={onMenuOpenChange}
                />
              }
            />
          </div>
        ))}
      </div>
    </WorktreeCardDetailSection>
  )
}
