import { useState, type MouseEvent, type ReactNode } from 'react'
import { Copy, Ellipsis, Globe, ListTodo, MonitorUp, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import { DetailHeader } from './WorktreeCardMetadataControls'
import { WorktreeCardReferenceRow } from './WorktreeCardReferenceRow'
import { getWorkspaceAttachmentSourceLabel } from './workspace-attachment-source-label'
import { getIssueTaskState, getLinearTaskState } from './worktree-task-state'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import { workspaceAttachmentProviderLabel } from './worktree-attachment-editing'
import type {
  WorktreeCardIssueDisplay,
  WorktreeCardJiraIssueDisplay,
  WorktreeCardLinearIssueDisplay
} from './worktree-card-meta-types'

type TaskMenuItem = {
  key: string
  icon: ReactNode
  label: string
  onClick: (event: MouseEvent) => void
}

export function WorktreeCardTaskActions({
  label: moreActionsLabel,
  items,
  open,
  onOpenChange
}: {
  label: string
  items: TaskMenuItem[]
  open?: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = open ?? internalOpen
  if (!items.length) {
    return null
  }
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-5 shrink-0"
        aria-label={moreActionsLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <Ellipsis className="size-3" />
      </Button>
    </DropdownMenuTrigger>
  )
  return (
    <DropdownMenu
      modal={false}
      open={isOpen}
      onOpenChange={(next) => {
        setInternalOpen(next)
        onOpenChange(next)
      }}
    >
      {isOpen ? (
        trigger
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {moreActionsLabel}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenuContent
        align="end"
        className="w-48"
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <DropdownMenuItem key={item.key} onClick={item.onClick}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const moreProviderActionsLabel = (provider: string): string =>
  translate('auto.components.sidebar.WorktreeCardMeta.dbe2d18972', 'More {{value0}} actions', {
    value0: provider
  })

export function getTaskMenuItems({
  url,
  onOpenInOrca,
  onOpenInBrowser,
  onEdit,
  onCopyLink
}: {
  url?: string
  onOpenInOrca?: (event: MouseEvent) => void
  onOpenInBrowser?: (url: string) => void
  onEdit?: (event: MouseEvent) => void
  onCopyLink?: (url: string) => void
}): TaskMenuItem[] {
  const items: TaskMenuItem[] = []
  if (url && onOpenInOrca) {
    items.push({
      key: 'orca',
      icon: <MonitorUp className="size-3.5" />,
      label: translate('auto.components.sidebar.WorktreeCardMeta.2c67730e07', 'Open in Orca'),
      onClick: onOpenInOrca
    })
  }
  if (url && onOpenInBrowser) {
    items.push({
      key: 'browser',
      icon: <Globe className="size-3.5" />,
      label: translate(
        'auto.components.sidebar.WorktreeCardMeta.openInOrcaBrowser',
        'Open in Orca browser'
      ),
      onClick: () => onOpenInBrowser(url)
    })
  }
  if (onEdit) {
    items.push({
      key: 'edit',
      icon: <Pencil className="size-3.5" />,
      label: translate('auto.components.sidebar.WorktreeCardMeta.807b13b9ec', 'Edit issue'),
      onClick: onEdit
    })
  }
  if (url && onCopyLink) {
    items.push({
      key: 'copy',
      icon: <Copy className="size-3.5" />,
      label: translate('auto.components.sidebar.WorktreeCardMeta.copyLink', 'Copy link'),
      onClick: () => onCopyLink(url)
    })
  }
  return items
}

export function WorktreeCardLinkedTaskActions({
  item,
  url,
  isCardTask,
  onOpenChange,
  onCopyLink,
  onEditIssue,
  onOpenGitHubIssueInOrca,
  onOpenIssueInBrowser,
  onOpenLinearIssueInOrca
}: {
  item: WorkspaceAttachment
  url?: string
  /** Card-level actions only target the card's own issue or task. */
  isCardTask: boolean
  onOpenChange: (open: boolean) => void
  onCopyLink?: (url: string) => void
  onEditIssue?: (event: MouseEvent) => void
  onOpenGitHubIssueInOrca?: (event: MouseEvent) => void
  onOpenIssueInBrowser?: (url: string) => void
  onOpenLinearIssueInOrca?: (event: MouseEvent) => void
}): React.JSX.Element | null {
  const github = item.provider === 'github'
  return (
    <WorktreeCardTaskActions
      label={
        github
          ? translate(
              'auto.components.sidebar.WorktreeCardMeta.moreIssueActions',
              'More issue actions'
            )
          : moreProviderActionsLabel(workspaceAttachmentProviderLabel(item))
      }
      items={getTaskMenuItems({
        url,
        onOpenInOrca: !isCardTask
          ? undefined
          : github
            ? onOpenGitHubIssueInOrca
            : item.provider === 'linear'
              ? onOpenLinearIssueInOrca
              : undefined,
        onOpenInBrowser: onOpenIssueInBrowser,
        onEdit: isCardTask && github ? onEditIssue : undefined,
        onCopyLink
      })}
      onOpenChange={onOpenChange}
    />
  )
}

export function WorktreeCardTaskDetailSection({
  issue,
  linearIssue,
  jiraIssue,
  issueMenuOpen,
  onIssueMenuOpenChange,
  onOpenLink,
  onCopyLink,
  onEditIssue,
  onOpenGitHubIssueInOrca,
  onOpenIssueInBrowser,
  onOpenLinearIssueInOrca,
  onManageLinks
}: {
  issue?: WorktreeCardIssueDisplay | null
  linearIssue?: WorktreeCardLinearIssueDisplay | null
  jiraIssue?: WorktreeCardJiraIssueDisplay | null
  issueMenuOpen: boolean
  onIssueMenuOpenChange: (open: boolean) => void
  onOpenLink: (url: string, event: MouseEvent) => void
  onCopyLink?: (url: string) => void
  onEditIssue?: (event: MouseEvent) => void
  onOpenGitHubIssueInOrca?: (event: MouseEvent) => void
  onOpenIssueInBrowser?: (url: string) => void
  onOpenLinearIssueInOrca?: (event: MouseEvent) => void
  onManageLinks?: (event: MouseEvent) => void
}): React.JSX.Element | null {
  const rows: { key: string; node: ReactNode }[] = []
  if (issue) {
    rows.push({
      key: 'github-issue',
      node: (
        <WorktreeCardReferenceRow
          review={null}
          kind="issue"
          title={issue.title}
          label={translate('workspace.links.issueReference', 'Issue #{{number}}', {
            number: issue.number
          })}
          provider="GitHub"
          source={getWorkspaceAttachmentSourceLabel({
            provider: 'github',
            type: 'issue',
            number: issue.number,
            url: issue.url
          })}
          taskState={getIssueTaskState(issue.state)}
          labels={issue.labels}
          url={issue.url}
          onOpen={onOpenLink}
          onManage={onEditIssue}
          actions={
            <WorktreeCardTaskActions
              label={translate(
                'auto.components.sidebar.WorktreeCardMeta.moreIssueActions',
                'More issue actions'
              )}
              items={getTaskMenuItems({
                url: issue.url,
                onOpenInOrca: onOpenGitHubIssueInOrca,
                onOpenInBrowser: onOpenIssueInBrowser,
                onEdit: onEditIssue,
                onCopyLink
              })}
              open={issueMenuOpen}
              onOpenChange={onIssueMenuOpenChange}
            />
          }
        />
      )
    })
  }

  if (linearIssue) {
    rows.push({
      key: 'linear-issue',
      node: (
        <WorktreeCardReferenceRow
          review={null}
          kind="issue"
          title={linearIssue.title}
          label={linearIssue.identifier}
          provider="Linear"
          source={
            linearIssue.url
              ? getWorkspaceAttachmentSourceLabel({
                  provider: 'linear',
                  type: 'issue',
                  number: 0,
                  identifier: linearIssue.identifier,
                  url: linearIssue.url
                })
              : null
          }
          taskState={getLinearTaskState(linearIssue.stateName, linearIssue.stateType)}
          labels={linearIssue.labels}
          url={linearIssue.url}
          onOpen={onOpenLink}
          actions={
            <WorktreeCardTaskActions
              label={moreProviderActionsLabel('Linear')}
              items={getTaskMenuItems({
                url: linearIssue.url,
                onOpenInOrca: onOpenLinearIssueInOrca,
                onOpenInBrowser: onOpenIssueInBrowser,
                onCopyLink
              })}
              onOpenChange={onIssueMenuOpenChange}
            />
          }
        />
      )
    })
  }

  if (jiraIssue) {
    rows.push({
      key: 'jira-issue',
      node: (
        <WorktreeCardReferenceRow
          review={null}
          kind="issue"
          title={jiraIssue.title}
          label={jiraIssue.identifier}
          provider="Jira"
          source={getWorkspaceAttachmentSourceLabel({
            provider: 'jira',
            type: 'issue',
            number: 0,
            identifier: jiraIssue.identifier,
            url: jiraIssue.url
          })}
          url={jiraIssue.url}
          onOpen={onOpenLink}
          actions={
            <WorktreeCardTaskActions
              label={moreProviderActionsLabel('Jira')}
              items={getTaskMenuItems({
                url: jiraIssue.url,
                onOpenInBrowser: onOpenIssueInBrowser,
                onCopyLink
              })}
              onOpenChange={onIssueMenuOpenChange}
            />
          }
        />
      )
    })
  }

  if (!rows.length) {
    return null
  }
  return (
    <WorktreeCardDetailSection>
      <DetailHeader
        icon={<ListTodo className="size-3" />}
        label={`${translate('workspace.links.tasks', 'Issues & tasks')} · ${rows.length}`}
        onAddReference={onManageLinks}
      />
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.key} className="py-1.5">
            {row.node}
          </div>
        ))}
      </div>
    </WorktreeCardDetailSection>
  )
}
