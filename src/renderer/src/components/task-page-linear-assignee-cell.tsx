import React, { useCallback, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTeamMembers } from '@/hooks/useIssueMetadata'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { linearUpdateIssue } from '@/runtime/runtime-linear-client'
import { useAppStore } from '@/store'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { LinearIssue } from '../../../shared/types'

export function LinearAssigneeCell({
  issue,
  className,
  sourceContext,
  onIssuePatch,
  variant = 'avatar'
}: {
  issue: LinearIssue
  className?: string
  sourceContext?: TaskSourceContext | null
  onIssuePatch?: (issueId: string, patch: Partial<LinearIssue>) => void
  variant?: 'avatar' | 'name'
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const [open, setOpen] = useState(false)
  // Why: a list renders one cell per row; only fetch members for the team the user actually opens.
  const members = useTeamMembers(open ? issue.team.id : null, providerSettings, issue.workspaceId)
  const [pending, setPending] = useState(false)
  const reqRef = useRef(0)

  const handleAssigneeChange = useCallback(
    (memberId: string | null) => {
      const nextAssigneeId = memberId
      if ((issue.assignee?.id ?? null) === nextAssigneeId || pending) {
        return
      }

      const member =
        nextAssigneeId == null ? undefined : members.data.find((m) => m.id === nextAssigneeId)
      if (nextAssigneeId != null && !member) {
        return
      }

      reqRef.current += 1
      const reqId = reqRef.current
      const previousAssignee = issue.assignee
      const nextAssignee = member
        ? { id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl }
        : undefined

      setPending(true)
      patchLinearIssue(issue.id, { assignee: nextAssignee }, { sourceContext })
      onIssuePatch?.(issue.id, { assignee: nextAssignee })
      void linearUpdateIssue(
        providerSettings,
        issue.id,
        { assigneeId: nextAssigneeId },
        issue.workspaceId
      )
        .then((result) => {
          if (reqId !== reqRef.current) {
            return
          }
          if (result.ok === false) {
            patchLinearIssue(issue.id, { assignee: previousAssignee }, { sourceContext })
            onIssuePatch?.(issue.id, { assignee: previousAssignee })
            toast.error(
              result.error ??
                translate(
                  'auto.components.TaskPage.linearAssigneeUpdateFailed',
                  'Failed to update Linear assignee'
                )
            )
            return
          }
          useAppStore.getState().invalidateLinearIssueLists({ sourceContext })
          useAppStore.getState().recordFeatureInteraction('linear-tasks')
        })
        .catch(() => {
          if (reqId !== reqRef.current) {
            return
          }
          patchLinearIssue(issue.id, { assignee: previousAssignee }, { sourceContext })
          onIssuePatch?.(issue.id, { assignee: previousAssignee })
          toast.error(
            translate(
              'auto.components.TaskPage.linearAssigneeUpdateFailed',
              'Failed to update Linear assignee'
            )
          )
        })
        .finally(() => {
          if (reqId === reqRef.current) {
            setPending(false)
          }
        })
    },
    [
      issue.assignee,
      issue.id,
      issue.workspaceId,
      members.data,
      onIssuePatch,
      patchLinearIssue,
      pending,
      providerSettings,
      sourceContext
    ]
  )

  const unassignedLabel = translate('auto.components.TaskPage.42a9160321', 'Unassigned')
  const displayName = issue.assignee?.displayName ?? unassignedLabel
  const triggerContent =
    variant === 'name' ? (
      <span className="min-w-0 truncate">{displayName}</span>
    ) : issue.assignee ? (
      issue.assignee.avatarUrl ? (
        <img
          src={issue.assignee.avatarUrl}
          alt={issue.assignee.displayName}
          className="size-5 rounded-full"
        />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px] text-muted-foreground">
          {issue.assignee.displayName.slice(0, 1)}
        </span>
      )
    ) : (
      <span className="text-xs text-muted-foreground/60">-</span>
    )
  const trigger = (
    <button
      type="button"
      disabled={pending}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex min-w-0 max-w-full cursor-pointer! items-center gap-1 text-left transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default! disabled:opacity-80',
        variant === 'avatar'
          ? 'justify-center rounded-full p-0.5'
          : 'rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground',
        className
      )}
      aria-label={
        issue.assignee
          ? translate(
              'auto.components.TaskPage.linearChangeAssigneeFrom',
              'Change assignee from {{value0}}',
              { value0: issue.assignee.displayName }
            )
          : translate('auto.components.TaskPage.linearAssignIssue', 'Assign Linear issue')
      }
      aria-busy={pending || members.loading}
    >
      {triggerContent}
      {pending || members.loading ? (
        <LoaderCircle className="size-3 shrink-0 animate-spin opacity-70" />
      ) : variant === 'name' ? (
        <ChevronDown className="size-3 shrink-0 opacity-55" />
      ) : null}
    </button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {variant === 'avatar' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {displayName}
          </TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        className="popover-scroll-content scrollbar-sleek w-48 p-1"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-pressed={issue.assignee == null}
          onClick={() => {
            handleAssigneeChange(null)
            setOpen(false)
          }}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
            issue.assignee == null && 'bg-accent/50'
          )}
        >
          {unassignedLabel}
        </button>
        {members.error ? (
          <div className="px-2 py-3 text-center text-[12px] text-destructive">{members.error}</div>
        ) : members.loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            {translate('auto.components.TaskPage.linearLoadingMembers', 'Loading members')}
          </div>
        ) : members.data.length > 0 ? (
          members.data.map((member) => (
            <button
              key={member.id}
              type="button"
              aria-label={member.displayName}
              aria-pressed={issue.assignee?.id === member.id}
              onClick={() => {
                handleAssigneeChange(member.id)
                setOpen(false)
              }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                issue.assignee?.id === member.id && 'bg-accent/50'
              )}
            >
              {member.avatarUrl ? (
                <img src={member.avatarUrl} alt="" className="size-4 shrink-0 rounded-full" />
              ) : (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                  {member.displayName.slice(0, 1)}
                </span>
              )}
              <span className="min-w-0 truncate">{member.displayName}</span>
            </button>
          ))
        ) : (
          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
            {translate('auto.components.TaskPage.linearNoMembersFound', 'No members found')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
