import React from 'react'
import { Check, ChevronDown, FolderKanban, LoaderCircle, Tag } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import type { MetadataListState } from '@/hooks/useMetadataListRequest'
import { translate } from '@/i18n/i18n'
import type { LinearProjectSummary } from '../../../../../shared/linear/project-types'
import type { LinearLabel } from '../../../../../shared/linear/workspace-types'

export type NewLinearIssueMorePickersProps = {
  newLinearIssueSubmitting: boolean
  newLinearIssuePriority: number
  setNewLinearIssuePriority: (priority: number) => void
  newLinearIssueProjects: LinearProjectSummary[]
  newLinearIssueProjectId: string | null
  setNewLinearIssueProjectId: (id: string | null) => void
  newLinearIssueProjectsLoading: boolean
  newLinearIssueLabelIds: string[]
  setNewLinearIssueLabelIds: (ids: string[]) => void
  newLinearLabels: MetadataListState<LinearLabel>
}

export function NewLinearIssueMorePickers({
  newLinearIssueSubmitting,
  newLinearIssuePriority,
  setNewLinearIssuePriority,
  newLinearIssueProjects,
  newLinearIssueProjectId,
  setNewLinearIssueProjectId,
  newLinearIssueProjectsLoading,
  newLinearIssueLabelIds,
  setNewLinearIssueLabelIds,
  newLinearLabels
}: NewLinearIssueMorePickersProps): React.JSX.Element {
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            <LinearPriorityIcon priority={newLinearIssuePriority} className="size-3.5" />
            <span>
              {newLinearIssuePriority === 1
                ? translate('auto.components.TaskPage.f373ab1a4f', 'Urgent')
                : newLinearIssuePriority === 2
                  ? translate('auto.components.TaskPage.345b169f1f', 'High')
                  : newLinearIssuePriority === 3
                    ? translate('auto.components.TaskPage.7fd59c18d8', 'Medium')
                    : newLinearIssuePriority === 4
                      ? translate('auto.components.TaskPage.69591944e7', 'Low')
                      : translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}
          </div>
          {[
            { val: 0, label: translate('auto.components.TaskPage.713179dfdc', 'No priority') },
            { val: 1, label: translate('auto.components.TaskPage.f373ab1a4f', 'Urgent') },
            { val: 2, label: translate('auto.components.TaskPage.345b169f1f', 'High') },
            { val: 3, label: translate('auto.components.TaskPage.7fd59c18d8', 'Medium') },
            { val: 4, label: translate('auto.components.TaskPage.69591944e7', 'Low') }
          ].map((p) => (
            <button
              key={p.val}
              type="button"
              onClick={() => setNewLinearIssuePriority(p.val)}
              className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                newLinearIssuePriority === p.val
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-foreground/80'
              }`}
            >
              <div className="flex items-center gap-2">
                <LinearPriorityIcon priority={p.val} className="size-3.5" />
                <span>{p.label}</span>
              </div>
              {newLinearIssuePriority === p.val && <Check className="size-3 text-foreground" />}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            <FolderKanban className="size-3.5 text-muted-foreground/70" />
            <span className="truncate max-w-[120px]">
              {(() => {
                const selectedProj = newLinearIssueProjects.find(
                  (p) => p.id === newLinearIssueProjectId
                )
                return (
                  selectedProj?.name || translate('auto.components.TaskPage.00022ec0ba', 'Project')
                )
              })()}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.00022ec0ba', 'Project')}
          </div>
          {newLinearIssueProjectsLoading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div>
              <button
                type="button"
                onClick={() => setNewLinearIssueProjectId(null)}
                className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                  newLinearIssueProjectId === null
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-foreground/80'
                }`}
              >
                <div className="flex items-center gap-2">
                  <FolderKanban className="size-3.5 text-muted-foreground/50" />
                  <span>{translate('auto.components.TaskPage.1742eafc14', 'No Project')}</span>
                </div>
                {newLinearIssueProjectId === null && <Check className="size-3 text-foreground" />}
              </button>
              {newLinearIssueProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setNewLinearIssueProjectId(p.id)}
                  className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                    newLinearIssueProjectId === p.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-foreground/80'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <FolderKanban className="size-3.5 text-muted-foreground/70 flex-shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </div>
                  {newLinearIssueProjectId === p.id && <Check className="size-3 text-foreground" />}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            <Tag className="size-3.5 text-muted-foreground/70" />
            <span>
              {newLinearIssueLabelIds.length === 0
                ? translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')
                : translate('auto.components.TaskPage.eff9800d4b', '{{value0}} label{{value1}}', {
                    value0: newLinearIssueLabelIds.length,
                    value1: newLinearIssueLabelIds.length > 1 ? 's' : ''
                  })}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}
          </div>
          {newLinearLabels.loading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div>
              {newLinearLabels.data.map((l) => {
                const isSelected = newLinearIssueLabelIds.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      if (isSelected) {
                        setNewLinearIssueLabelIds(
                          newLinearIssueLabelIds.filter((id) => id !== l.id)
                        )
                      } else {
                        setNewLinearIssueLabelIds([...newLinearIssueLabelIds, l.id])
                      }
                    }}
                    className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                      isSelected ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: l.color || '#a3a3a3' }}
                      />
                      <span>{l.name}</span>
                    </div>
                    {isSelected && <Check className="size-3 text-foreground" />}
                  </button>
                )
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  )
}
