import React from 'react'
import { Check, ChevronDown, Clock3, LoaderCircle, Tag, UserRound, Users } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import { getLinearPriorityLabel } from '@/components/task-page-localized-options'
import type { MetadataListState } from '@/hooks/useMetadataListRequest'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { LinearLabel, LinearMember } from '../../../../../shared/linear/workspace-types'

export type NewLinearProjectFieldsProps = {
  newLinearProjectSubmitting: boolean
  newLinearProjectPriority: number
  setNewLinearProjectPriority: (priority: number) => void
  newLinearProjectMembers: MetadataListState<LinearMember>
  newLinearProjectLeadId: string | null
  setNewLinearProjectLeadId: (id: string | null) => void
  newLinearProjectMemberIds: string[]
  setNewLinearProjectMemberIds: React.Dispatch<React.SetStateAction<string[]>>
  newLinearProjectLabelIds: string[]
  setNewLinearProjectLabelIds: React.Dispatch<React.SetStateAction<string[]>>
  newLinearProjectLabels: MetadataListState<LinearLabel>
  newLinearProjectStartDate: string
  setNewLinearProjectStartDate: (value: string) => void
  newLinearProjectTargetDate: string
  setNewLinearProjectTargetDate: (value: string) => void
}

export function NewLinearProjectFields({
  newLinearProjectSubmitting,
  newLinearProjectPriority,
  setNewLinearProjectPriority,
  newLinearProjectMembers,
  newLinearProjectLeadId,
  setNewLinearProjectLeadId,
  newLinearProjectMemberIds,
  setNewLinearProjectMemberIds,
  newLinearProjectLabelIds,
  setNewLinearProjectLabelIds,
  newLinearProjectLabels,
  newLinearProjectStartDate,
  setNewLinearProjectStartDate,
  newLinearProjectTargetDate,
  setNewLinearProjectTargetDate
}: NewLinearProjectFieldsProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearProjectSubmitting}
            className="flex items-center gap-1.5 rounded-md border border-border/80 bg-muted/15 px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted/50 active:bg-muted disabled:opacity-50"
          >
            <LinearPriorityIcon priority={newLinearProjectPriority} className="size-3.5" />
            <span>{getLinearPriorityLabel(newLinearProjectPriority)}</span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}
          </div>
          {[0, 1, 2, 3, 4].map((priority) => (
            <button
              key={priority}
              type="button"
              onClick={() => setNewLinearProjectPriority(priority)}
              className={cn(
                'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                newLinearProjectPriority === priority
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-foreground/80'
              )}
            >
              <span className="flex items-center gap-2">
                <LinearPriorityIcon priority={priority} className="size-3.5" />
                {getLinearPriorityLabel(priority)}
              </span>
              {newLinearProjectPriority === priority ? (
                <Check className="size-3 text-foreground" />
              ) : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearProjectSubmitting}
            className="flex items-center gap-1.5 rounded-md border border-border/80 bg-muted/15 px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted/50 active:bg-muted disabled:opacity-50"
          >
            <UserRound className="size-3.5 text-muted-foreground/70" />
            <span className="max-w-[120px] truncate">
              {newLinearProjectMembers.data.find((member) => member.id === newLinearProjectLeadId)
                ?.displayName ?? translate('auto.components.TaskPage.34da8ac06c', 'Lead')}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {translate('auto.components.TaskPage.34da8ac06c', 'Lead')}
          </div>
          {newLinearProjectMembers.loading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto scrollbar-sleek">
              <button
                type="button"
                onClick={() => setNewLinearProjectLeadId(null)}
                className={cn(
                  'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                  newLinearProjectLeadId === null
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-foreground/80'
                )}
              >
                <span className="flex items-center gap-2">
                  <UserRound className="size-3.5 text-muted-foreground/50" />
                  {translate('auto.components.TaskPage.cfaadb6b22', 'No lead')}
                </span>
                {newLinearProjectLeadId === null ? <Check className="size-3" /> : null}
              </button>
              {newLinearProjectMembers.data.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => setNewLinearProjectLeadId(member.id)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                    newLinearProjectLeadId === member.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-foreground/80'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {member.avatarUrl ? (
                      <img
                        src={member.avatarUrl}
                        alt={member.displayName}
                        className="size-3.5 flex-none rounded-full"
                      />
                    ) : (
                      <UserRound className="size-3.5 flex-none text-muted-foreground/70" />
                    )}
                    <span className="truncate">{member.displayName}</span>
                  </span>
                  {newLinearProjectLeadId === member.id ? (
                    <Check className="size-3 flex-none" />
                  ) : null}
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
            disabled={newLinearProjectSubmitting}
            className="flex items-center gap-1.5 rounded-md border border-border/80 bg-muted/15 px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted/50 active:bg-muted disabled:opacity-50"
          >
            <Users className="size-3.5 text-muted-foreground/70" />
            <span>
              {newLinearProjectMemberIds.length === 0
                ? translate('auto.components.TaskPage.d6cda23ef1', 'Members')
                : translate('auto.components.TaskPage.7719d8daa9', '{{value0}} member{{value1}}', {
                    value0: newLinearProjectMemberIds.length,
                    value1: newLinearProjectMemberIds.length > 1 ? 's' : ''
                  })}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {translate('auto.components.TaskPage.d6cda23ef1', 'Members')}
          </div>
          {newLinearProjectMembers.loading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto scrollbar-sleek">
              {newLinearProjectMembers.data.map((member) => {
                const selected = newLinearProjectMemberIds.includes(member.id)
                return (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() =>
                      setNewLinearProjectMemberIds((current) =>
                        selected
                          ? current.filter((id) => id !== member.id)
                          : [...current, member.id]
                      )
                    }
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                      selected ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {member.avatarUrl ? (
                        <img
                          src={member.avatarUrl}
                          alt={member.displayName}
                          className="size-3.5 flex-none rounded-full"
                        />
                      ) : (
                        <UserRound className="size-3.5 flex-none text-muted-foreground/70" />
                      )}
                      <span className="truncate">{member.displayName}</span>
                    </span>
                    {selected ? <Check className="size-3 flex-none" /> : null}
                  </button>
                )
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearProjectSubmitting}
            className="flex items-center gap-1.5 rounded-md border border-border/80 bg-muted/15 px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted/50 active:bg-muted disabled:opacity-50"
          >
            <Tag className="size-3.5 text-muted-foreground/70" />
            <span>
              {newLinearProjectLabelIds.length === 0
                ? translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')
                : translate('auto.components.TaskPage.eff9800d4b', '{{value0}} label{{value1}}', {
                    value0: newLinearProjectLabelIds.length,
                    value1: newLinearProjectLabelIds.length > 1 ? 's' : ''
                  })}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}
          </div>
          {newLinearProjectLabels.loading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto scrollbar-sleek">
              {newLinearProjectLabels.data.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {translate('auto.components.TaskPage.af9e877f30', 'No labels')}
                </div>
              ) : (
                newLinearProjectLabels.data.map((label) => {
                  const selected = newLinearProjectLabelIds.includes(label.id)
                  return (
                    <button
                      key={label.id}
                      type="button"
                      onClick={() =>
                        setNewLinearProjectLabelIds((current) =>
                          selected
                            ? current.filter((id) => id !== label.id)
                            : [...current, label.id]
                        )
                      }
                      className={cn(
                        'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                        selected ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-2 flex-none rounded-full bg-muted-foreground/40"
                          style={label.color ? { backgroundColor: label.color } : undefined}
                        />
                        <span className="truncate">{label.name}</span>
                      </span>
                      {selected ? <Check className="size-3 flex-none" /> : null}
                    </button>
                  )
                })
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">
          {translate('auto.components.TaskPage.7d08e8be0f', 'Start')}
        </span>
        <input
          type="date"
          value={newLinearProjectStartDate}
          onChange={(event) => setNewLinearProjectStartDate(event.target.value)}
          disabled={newLinearProjectSubmitting}
          className="h-5 min-w-[6.75rem] cursor-pointer border-none bg-transparent p-0 text-xs text-foreground outline-none disabled:cursor-not-allowed"
          aria-label={translate('auto.components.TaskPage.09623359b9', 'Start date')}
        />
      </label>

      <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
        <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">
          {translate('auto.components.TaskPage.7da41c9225', 'Target')}
        </span>
        <input
          type="date"
          value={newLinearProjectTargetDate}
          onChange={(event) => setNewLinearProjectTargetDate(event.target.value)}
          disabled={newLinearProjectSubmitting}
          className="h-5 min-w-[6.75rem] cursor-pointer border-none bg-transparent p-0 text-xs text-foreground outline-none disabled:cursor-not-allowed"
          aria-label={translate('auto.components.TaskPage.2ea1c701b6', 'Target date')}
        />
      </label>
    </div>
  )
}
