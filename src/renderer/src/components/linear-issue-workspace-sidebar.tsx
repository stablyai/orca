import React from 'react'
import { ChevronDown, Clipboard, FolderOpen, GitBranch } from 'lucide-react'

import { LinearIssueEditSection, type LinearEditState } from '@/components/LinearItemDrawer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { buildLinearIssueContextSnapshot } from '@/lib/linear-issue-context-snapshot'
import { buildContainedLinkedContextBlock } from '@/lib/linked-work-item-context'
import { translate } from '@/i18n/i18n'
import { buildLinearIssueBranchName } from '@/components/linear-issue-workspace-text'
import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearProjectSummary } from '../../../shared/linear/project-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { copyLinearIssueText } from './linear-issue-clipboard'
import { LinearIssueProjectSelector } from './linear-issue-project-selector'

function LinearIssueWorkspaceAttachmentCard({
  label,
  onOpen
}: {
  label: string | null
  onOpen: () => void
}): React.JSX.Element {
  return (
    <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
      <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
        <span>
          {translate('auto.components.LinearIssueWorkspace.workspaceSection', 'Workspace')}
        </span>
      </div>
      <div className="p-3">
        {label ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={translate(
              'auto.components.LinearIssueWorkspace.openAttachedWorkspace',
              'Open workspace attached to issue'
            )}
            className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FolderOpen className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        ) : (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {translate('auto.components.LinearIssueWorkspace.noWorkspaceYet', 'None yet')}
          </div>
        )}
      </div>
    </section>
  )
}

function LinearIssueActionsCard({
  issue,
  comments
}: {
  issue: LinearIssue
  comments: LinearComment[]
}): React.JSX.Element {
  const actionItems = [
    {
      label: translate('auto.components.LinearIssueWorkspace.9a9a884236', 'Copy URL'),
      icon: Clipboard,
      action: () => void copyLinearIssueText(issue.url, 'URL')
    },
    {
      label: translate('auto.components.LinearIssueWorkspace.30c1242f3a', 'Copy identifier'),
      icon: Clipboard,
      action: () => void copyLinearIssueText(issue.identifier, 'Identifier')
    },
    {
      label: translate(
        'auto.components.LinearIssueWorkspace.5d670ec8dc',
        'Copy suggested branch name'
      ),
      icon: GitBranch,
      action: () =>
        void copyLinearIssueText(buildLinearIssueBranchName(issue), 'Suggested branch name')
    },
    {
      label: translate('auto.components.LinearIssueWorkspace.f6c6381593', 'Copy prompt'),
      icon: Clipboard,
      action: () => {
        const renderedText = buildLinearIssueContextSnapshot(issue, comments)
        const prompt =
          buildContainedLinkedContextBlock({
            provider: 'linear',
            version: 1,
            renderedText
          }) ?? renderedText
        void copyLinearIssueText(prompt, 'Prompt')
      }
    }
  ]
  return (
    <section className="rounded-xl border border-border/60 bg-card text-card-foreground shadow-xs">
      <div className="flex h-10 items-center gap-1 border-b border-border/50 px-4 text-sm font-medium text-muted-foreground">
        <span>{translate('auto.components.LinearIssueWorkspace.c23e79e5c0', 'Actions')}</span>
        <ChevronDown className="size-3.5" />
      </div>
      <div className="space-y-1 p-3">
        {actionItems.map((item) => {
          const Icon = item.icon
          return (
            <Tooltip key={item.label}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={item.action}
                  className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" sideOffset={6}>
                {item.label}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </section>
  )
}

export function LinearIssueWorkspaceSidebar({
  issue,
  comments,
  editState,
  attachedWorkspaceLabel,
  onEditStateChange,
  onProjectChanged,
  onOpenAttachedWorkspace,
  sourceContext
}: {
  issue: LinearIssue
  comments: LinearComment[]
  editState: LinearEditState
  attachedWorkspaceLabel: string | null
  onEditStateChange: (patch: Partial<LinearEditState>) => void
  onProjectChanged: (project: LinearProjectSummary) => void
  onOpenAttachedWorkspace: () => void
  sourceContext?: TaskSourceContext | null
}): React.JSX.Element {
  return (
    <aside className="space-y-3 lg:sticky lg:top-6 lg:self-start">
      <LinearIssueEditSection
        issue={issue}
        editState={editState}
        onEditStateChange={onEditStateChange}
        layout="properties"
        sourceContext={sourceContext}
      />
      <LinearIssueProjectSelector
        issue={issue}
        onProjectChanged={onProjectChanged}
        sourceContext={sourceContext}
      />
      <LinearIssueWorkspaceAttachmentCard
        label={attachedWorkspaceLabel}
        onOpen={onOpenAttachedWorkspace}
      />
      <LinearIssueActionsCard issue={issue} comments={comments} />
    </aside>
  )
}
