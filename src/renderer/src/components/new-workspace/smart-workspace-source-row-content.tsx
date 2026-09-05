import React from 'react'
import {
  CaseSensitive,
  CircleDot,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequest
} from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { JiraSite } from '../../../../shared/jira-types'
import type { RowEntry, SmartWorkspaceNameSelection } from './smart-workspace-name-field-model'

const ROW_ITEM_CLASS_NAME = 'gap-2 px-3 py-2 text-xs'

function isTypedTextSourceRow(row: RowEntry): boolean {
  return row.kind === 'use-name' || row.kind === 'create-branch'
}

export function getRowItemClassName(row: RowEntry, options?: { pinnedAction?: boolean }): string {
  return cn(
    ROW_ITEM_CLASS_NAME,
    options?.pinnedAction && isTypedTextSourceRow(row) && 'bg-muted/35'
  )
}

export function RowIcon({ row }: { row: RowEntry }): React.JSX.Element {
  if (row.kind === 'use-name') {
    return <CaseSensitive className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (row.kind === 'create-branch') {
    return <GitBranchPlus className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (row.kind === 'github') {
    return row.item.type === 'pr' ? (
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
    )
  }
  if (row.kind === 'gitlab') {
    // Why: GitMerge keeps merge requests visually distinct from PRs and branches.
    return row.item.type === 'mr' ? (
      <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
    )
  }
  if (row.kind === 'branch') {
    return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (row.kind === 'jira' || row.kind === 'jira-account') {
    return <JiraIcon className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <LinearIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

export function SelectionIcon({
  kind
}: {
  kind: SmartWorkspaceNameSelection['kind']
}): React.JSX.Element {
  if (kind === 'github-pr') {
    return <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'gitlab-mr') {
    return <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'github-issue' || kind === 'gitlab-issue') {
    return <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'branch') {
    return <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (kind === 'jira') {
    return <JiraIcon className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <LinearIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

export function RowLabel({
  row,
  jiraSite = null,
  showJiraSiteContext = false
}: {
  row: RowEntry
  jiraSite?: JiraSite | null
  showJiraSiteContext?: boolean
}): React.JSX.Element {
  if (row.kind === 'use-name') {
    return (
      <span className="min-w-0 truncate">
        {translate('auto.components.new.workspace.SmartWorkspaceNameField.b1a7d679ba', 'Use')}{' '}
        <span className="font-medium text-foreground">
          {translate('auto.components.new.workspace.SmartWorkspaceNameField.34ca97bce3', '"')}
          {row.name}
          {translate('auto.components.new.workspace.SmartWorkspaceNameField.766083a596', '"')}
        </span>{' '}
        {translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.a44229ce4d',
          'as workspace name'
        )}
      </span>
    )
  }
  if (row.kind === 'create-branch') {
    return (
      <span className="min-w-0 truncate">
        {translate(
          'auto.components.new.workspace.SmartWorkspaceNameField.2a0d535f69',
          'Create new branch'
        )}{' '}
        <span className="font-mono text-[11px] font-medium text-foreground">{row.name}</span>
      </span>
    )
  }
  if (row.kind === 'github') {
    return (
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">#{row.item.number}</span> {row.item.title}
      </span>
    )
  }
  if (row.kind === 'gitlab') {
    const prefix = row.item.type === 'mr' ? '!' : '#'
    return (
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">
          {prefix}
          {row.item.number}
        </span>{' '}
        {row.item.title}
      </span>
    )
  }
  if (row.kind === 'branch') {
    return <span className="min-w-0 truncate font-mono text-[11px]">{row.refName}</span>
  }
  if (row.kind === 'jira') {
    const siteLabel = jiraSite
      ? `${jiraSite.displayName} — ${jiraSite.email || jiraSite.siteUrl}`
      : row.issue.siteName
    return (
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{row.issue.key}</span> {row.issue.title}
        {showJiraSiteContext && siteLabel ? (
          <span className="text-muted-foreground"> — {siteLabel}</span>
        ) : null}
      </span>
    )
  }
  if (row.kind === 'jira-account') {
    return (
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{row.site.displayName}</span>
        {row.site.email ? ` — ${row.site.email}` : ''}
      </span>
    )
  }
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium text-foreground">{row.issue.identifier}</span> {row.issue.title}
    </span>
  )
}
