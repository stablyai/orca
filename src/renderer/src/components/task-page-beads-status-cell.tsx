import React, { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { BeadsIssueStatus } from '../../../shared/beads-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { TaskPageBeadsIssueRow } from './task-page-beads-issues'
import {
  BEADS_STATUS_ICONS,
  BEADS_STATUS_ORDER,
  getBeadsStatusLabels,
  getBeadsStatusShortLabels,
  getBeadsStatusTone
} from './task-page-beads-status-visuals'

type UpdateBeadsIssueStatusAction = (
  sourceContext: TaskSourceContext,
  issueId: string,
  status: BeadsIssueStatus
) => Promise<unknown>

// Why: the status-write store action ships separately; read it dynamically so
// the pill degrades to a read-only badge until the store gains the action.
function selectUpdateBeadsIssueStatus(state: unknown): UpdateBeadsIssueStatusAction | null {
  const action = (state as Record<string, unknown>)['updateBeadsIssueStatus']
  return typeof action === 'function' ? (action as UpdateBeadsIssueStatusAction) : null
}

/** Status pill with icon + label like GHStatusCell; dropdown writes through the beads store when available. */
export function BeadsStatusCell({ row }: { row: TaskPageBeadsIssueRow }): React.JSX.Element {
  const updateStatus = useAppStore(selectUpdateBeadsIssueStatus)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [draftStatus, setDraftStatus] = useState<BeadsIssueStatus | null>(null)
  const { issue } = row
  useEffect(() => {
    // Why: a cache refresh confirms or reverts the optimistic draft.
    setDraftStatus(null)
  }, [issue.status])
  const shownStatus = draftStatus ?? issue.status
  const statusLabels = getBeadsStatusLabels()
  const statusShortLabels = getBeadsStatusShortLabels()
  const ShownIcon = BEADS_STATUS_ICONS[shownStatus]

  if (!updateStatus) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium',
          getBeadsStatusTone(shownStatus)
        )}
      >
        <ShownIcon className="size-2.5" />
        <span>{statusShortLabels[shownStatus]}</span>
      </span>
    )
  }

  const handleStatusChange = (next: BeadsIssueStatus): void => {
    if (pending || next === shownStatus) {
      return
    }
    setDraftStatus(next)
    setPending(true)
    updateStatus(row.sourceContext, issue.id, next)
      .catch(() => {
        setDraftStatus(null)
        toast.error(
          translate('auto.components.TaskPage.beadsStatusUpdateFailed', 'Failed to update status')
        )
      })
      .finally(() => setPending(false))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            'group/status inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10',
            getBeadsStatusTone(shownStatus)
          )}
        >
          <ShownIcon className="size-2.5" />
          <span>{statusShortLabels[shownStatus]}</span>
          <ChevronDown className="size-2.5 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-1"
        align="start"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {BEADS_STATUS_ORDER.map((status) => {
          const Icon = BEADS_STATUS_ICONS[status]
          return (
            <button
              key={status}
              type="button"
              onClick={() => {
                handleStatusChange(status)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                shownStatus === status && 'bg-accent/50'
              )}
            >
              <Icon className="size-4 text-muted-foreground" />
              {statusLabels[status]}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
