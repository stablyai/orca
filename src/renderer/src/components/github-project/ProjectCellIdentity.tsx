import React from 'react'
import { FileText, GitPullRequest, Lock } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { GitHubIssueType, GitHubProjectRow } from '../../../../shared/github/project-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ProjectIssueTypeCell } from './ProjectCellIssueType'

export function ProjectTitleCell({
  row,
  onOpenDialog
}: {
  row: GitHubProjectRow
  onOpenDialog?: () => void
}): React.JSX.Element {
  if (row.itemType === 'REDACTED') {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Lock className="size-3.5" />
        <span className="italic">
          {translate('auto.components.github.project.ProjectCell.af5d8c912a', 'Restricted item')}
        </span>
      </div>
    )
  }
  const content = (
    <div className="flex min-w-0 items-center gap-2">
      {row.itemType === 'PULL_REQUEST' ? (
        <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      {row.content.number != null ? (
        <span className="shrink-0 text-xs text-muted-foreground">#{row.content.number}</span>
      ) : null}
      <span className="truncate text-sm font-medium">{row.content.title}</span>
    </div>
  )
  if (row.itemType === 'DRAFT_ISSUE') {
    return <div className="flex items-center gap-2">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={onOpenDialog}
      className="flex h-full w-full min-w-0 cursor-pointer items-center text-left hover:underline"
    >
      {content}
    </button>
  )
}

export function ProjectTypeCell({
  row,
  editable,
  sourceHost,
  sourceSettings,
  onEditIssueType
}: {
  row: GitHubProjectRow
  editable: boolean
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onEditIssueType?: (issueType: GitHubIssueType | null) => void
}): React.JSX.Element {
  if (row.itemType === 'ISSUE') {
    return (
      <ProjectIssueTypeCell
        row={row}
        editable={editable}
        sourceHost={sourceHost}
        sourceSettings={sourceSettings}
        onEditIssueType={onEditIssueType}
      />
    )
  }
  const meta =
    row.itemType === 'PULL_REQUEST'
      ? {
          Icon: GitPullRequest,
          label: translate('auto.components.github.project.ProjectCell.d0d0e13a5a', 'PR')
        }
      : row.itemType === 'DRAFT_ISSUE'
        ? {
            Icon: FileText,
            label: translate('auto.components.github.project.ProjectCell.6efdc0d920', 'Draft')
          }
        : {
            Icon: Lock,
            label: translate('auto.components.github.project.ProjectCell.8d669084f6', 'Restricted')
          }
  const { Icon, label } = meta
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
