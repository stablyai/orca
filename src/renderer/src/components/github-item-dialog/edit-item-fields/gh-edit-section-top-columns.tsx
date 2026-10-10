import React from 'react'
import { FolderKanban } from 'lucide-react'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskPageGitHubCloseAction } from '@/components/task-page-github-status-actions'
import { translate } from '@/i18n/i18n'
import { GHEditSectionStatusPopover } from './gh-edit-section-status-popover'
import { GHEditSectionAssigneesColumn } from './gh-edit-section-assignees'
import { GHEditSectionLabelsColumn } from './gh-edit-section-labels'

export function GHEditSectionTopColumns({
  item,
  localState,
  localLabels,
  localAssignees,
  repoLabels,
  repoAssignees,
  repositoryLabelsUrl,
  attachedWorkspaceLabel,
  isStatePending,
  isAssigneesPending,
  isLabelsPending,
  statusPopoverOpen,
  assigneePopoverOpen,
  labelPopoverOpen,
  duplicatePickerOpen,
  duplicateSearch,
  duplicateError,
  duplicatePickerTitle,
  filteredDuplicateCandidates,
  directDuplicateTarget,
  onStatusOpenChange,
  onAssigneeOpenChange,
  onLabelOpenChange,
  onStateChange,
  onDuplicateSearchChange,
  onDuplicateSearchSubmit,
  onCloseAsDuplicate,
  onBackFromDuplicate,
  onOpenDuplicatePicker,
  onAssigneeToggle,
  onLabelToggle
}: {
  item: GitHubWorkItem
  localState: GitHubWorkItem['state']
  localLabels: string[]
  localAssignees: string[]
  repoLabels: { data: string[]; loading: boolean; error: string | null }
  repoAssignees: { data: GitHubAssignableUser[]; loading: boolean; error: string | null }
  repositoryLabelsUrl: string | null
  attachedWorkspaceLabel?: string | null
  isStatePending: boolean
  isAssigneesPending: boolean
  isLabelsPending: boolean
  statusPopoverOpen: boolean
  assigneePopoverOpen: boolean
  labelPopoverOpen: boolean
  duplicatePickerOpen: boolean
  duplicateSearch: string
  duplicateError: string | null
  duplicatePickerTitle: string
  filteredDuplicateCandidates: GitHubWorkItem[]
  directDuplicateTarget: number | null
  onStatusOpenChange: (open: boolean) => void
  onAssigneeOpenChange: (open: boolean) => void
  onLabelOpenChange: (open: boolean) => void
  onStateChange: (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => void
  onDuplicateSearchChange: (value: string) => void
  onDuplicateSearchSubmit: () => void
  onCloseAsDuplicate: (targetIssueNumber: number | string) => void
  onBackFromDuplicate: () => void
  onOpenDuplicatePicker: () => void
  onAssigneeToggle: (login: string) => void
  onLabelToggle: (label: string) => void
}): React.JSX.Element {
  // Why: lay property fields as top columns so the description isn't squeezed by a right rail.
  return (
    <aside className="grid grid-cols-2 gap-x-6 gap-y-5 text-[13px] sm:grid-cols-4">
      <section className="min-w-0">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('auto.components.GitHubItemDialog.00ccdf9b5a', 'Status')}
        </div>
        <GHEditSectionStatusPopover
          item={item}
          variant="sidebar"
          localState={localState}
          isPending={isStatePending}
          statusPopoverOpen={statusPopoverOpen}
          duplicatePickerOpen={duplicatePickerOpen}
          duplicateSearch={duplicateSearch}
          duplicateError={duplicateError}
          duplicatePickerTitle={duplicatePickerTitle}
          filteredDuplicateCandidates={filteredDuplicateCandidates}
          directDuplicateTarget={directDuplicateTarget}
          onOpenChange={onStatusOpenChange}
          onStateChange={onStateChange}
          onDuplicateSearchChange={onDuplicateSearchChange}
          onDuplicateSearchSubmit={onDuplicateSearchSubmit}
          onCloseAsDuplicate={onCloseAsDuplicate}
          onBackFromDuplicate={onBackFromDuplicate}
          onOpenDuplicatePicker={onOpenDuplicatePicker}
        />
      </section>
      <GHEditSectionAssigneesColumn
        localAssignees={localAssignees}
        repoAssignees={repoAssignees}
        isPending={isAssigneesPending}
        popoverOpen={assigneePopoverOpen}
        onPopoverOpenChange={onAssigneeOpenChange}
        onToggle={onAssigneeToggle}
      />
      <GHEditSectionLabelsColumn
        localLabels={localLabels}
        repoLabels={repoLabels}
        repositoryLabelsUrl={repositoryLabelsUrl}
        isPending={isLabelsPending}
        popoverOpen={labelPopoverOpen}
        onPopoverOpenChange={onLabelOpenChange}
        onToggle={onLabelToggle}
      />
      <section className="min-w-0">
        {/* Why: property columns are metadata only; the primary open/start CTA lives solely in the issue header. */}
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('auto.components.GitHubItemDialog.2e4d806c92', 'Workspace')}
        </div>
        {attachedWorkspaceLabel ? (
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            <FolderKanban className="size-3.5 shrink-0" />
            <span className="truncate">{attachedWorkspaceLabel}</span>
          </div>
        ) : (
          <div className="text-[12px] text-muted-foreground">
            {translate('auto.components.GitHubItemDialog.886a64b081', 'None yet')}
          </div>
        )}
      </section>
    </aside>
  )
}
