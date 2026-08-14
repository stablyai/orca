import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, Tag } from 'lucide-react'
import { toast } from 'sonner'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTeamLabels } from '@/hooks/useIssueMetadata'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { linearUpdateIssue } from '@/runtime/runtime-linear-client'
import { useAppStore } from '@/store'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { LinearIssue } from '../../../shared/types'

export function LinearLabelsCell({
  issue,
  className,
  sourceContext,
  onIssuePatch,
  maxVisible = 3,
  density = 'default'
}: {
  issue: LinearIssue
  className?: string
  sourceContext?: TaskSourceContext | null
  onIssuePatch?: (issueId: string, patch: Partial<LinearIssue>) => void
  maxVisible?: number
  density?: 'default' | 'compact'
}): React.JSX.Element {
  const triggerTextClass = density === 'compact' ? 'text-[10px]' : 'text-[11px]'
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const [open, setOpen] = useState(false)
  // Why: a list renders one cell per row; only fetch labels for the team the user actually opens.
  const teamLabels = useTeamLabels(open ? issue.team.id : null, providerSettings, issue.workspaceId)
  const [pending, setPending] = useState(false)
  const reqRef = useRef(0)

  const selectedIds = issue.labelIds
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const visibleLabels = issue.labels.slice(0, maxVisible).map((name, index) => ({
    id: issue.labelIds[index] ?? `${name}-${index}`,
    name
  }))

  const handleLabelToggle = useCallback(
    (labelId: string) => {
      if (pending) {
        return
      }

      const isRemoving = selectedIdSet.has(labelId)
      const nextLabelIds = isRemoving
        ? selectedIds.filter((id) => id !== labelId)
        : [...selectedIds, labelId]

      const labelNameById = new Map(teamLabels.data.map((label) => [label.id, label.name] as const))
      for (let i = 0; i < issue.labelIds.length; i += 1) {
        const id = issue.labelIds[i]
        const name = issue.labels[i]
        if (id && name && !labelNameById.has(id)) {
          labelNameById.set(id, name)
        }
      }

      const nextLabels = nextLabelIds
        .map((id) => labelNameById.get(id))
        .filter((name): name is string => name != null && name.length > 0)

      reqRef.current += 1
      const reqId = reqRef.current
      const previousLabelIds = issue.labelIds
      const previousLabels = issue.labels

      setPending(true)
      patchLinearIssue(issue.id, { labelIds: nextLabelIds, labels: nextLabels }, { sourceContext })
      onIssuePatch?.(issue.id, { labelIds: nextLabelIds, labels: nextLabels })
      void linearUpdateIssue(
        providerSettings,
        issue.id,
        { labelIds: nextLabelIds },
        issue.workspaceId
      )
        .then((result) => {
          if (reqId !== reqRef.current) {
            return
          }
          if (result.ok === false) {
            patchLinearIssue(
              issue.id,
              { labelIds: previousLabelIds, labels: previousLabels },
              { sourceContext }
            )
            onIssuePatch?.(issue.id, {
              labelIds: previousLabelIds,
              labels: previousLabels
            })
            toast.error(
              result.error ??
                translate(
                  'auto.components.TaskPage.linearLabelsUpdateFailed',
                  'Failed to update Linear labels'
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
          patchLinearIssue(
            issue.id,
            { labelIds: previousLabelIds, labels: previousLabels },
            { sourceContext }
          )
          onIssuePatch?.(issue.id, { labelIds: previousLabelIds, labels: previousLabels })
          toast.error(
            translate(
              'auto.components.TaskPage.linearLabelsUpdateFailed',
              'Failed to update Linear labels'
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
      issue.id,
      issue.labelIds,
      issue.labels,
      issue.workspaceId,
      onIssuePatch,
      patchLinearIssue,
      pending,
      providerSettings,
      selectedIdSet,
      selectedIds,
      sourceContext,
      teamLabels.data
    ]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex min-w-0 max-w-full cursor-pointer! items-center gap-1 rounded-sm text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default! disabled:opacity-80',
            className
          )}
          aria-label={
            issue.labels.length > 0
              ? translate('auto.components.TaskPage.linearLabelsAria', 'Labels: {{value0}}', {
                  value0: issue.labels.join(', ')
                })
              : translate('auto.components.TaskPage.linearAddLabel', 'Add label')
          }
          aria-busy={pending || teamLabels.loading}
        >
          {issue.labels.length > 0 ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {visibleLabels.map((label) => (
                <span
                  key={label.id}
                  className={cn(
                    'max-w-[150px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-muted-foreground',
                    triggerTextClass
                  )}
                >
                  {label.name}
                </span>
              ))}
              {issue.labels.length > visibleLabels.length ? (
                <span className={cn('text-muted-foreground', triggerTextClass)}>
                  +{issue.labels.length - visibleLabels.length}
                </span>
              ) : null}
            </span>
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-1 px-1 py-0.5 text-muted-foreground/70',
                triggerTextClass
              )}
            >
              <Tag className="size-3 shrink-0 opacity-70" />
              {translate('auto.components.TaskPage.linearAddLabel', 'Add label')}
            </span>
          )}
          {pending || teamLabels.loading ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin opacity-70" />
          ) : (
            <ChevronDown className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="popover-scroll-content scrollbar-sleek w-52 p-1"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        {teamLabels.error ? (
          <div className="px-2 py-3 text-center text-[12px] text-destructive">
            {teamLabels.error}
          </div>
        ) : teamLabels.loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            {translate('auto.components.TaskPage.linearLoadingLabels', 'Loading labels')}
          </div>
        ) : teamLabels.data.length > 0 ? (
          teamLabels.data.map((label) => {
            const isOn = selectedIdSet.has(label.id)
            return (
              <button
                key={label.id}
                type="button"
                disabled={pending}
                aria-pressed={isOn}
                onClick={() => handleLabelToggle(label.id)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent disabled:opacity-60"
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    isOn ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                  )}
                >
                  {isOn ? <Check className="size-2.5" /> : null}
                </span>
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                <span className="min-w-0 truncate">{label.name}</span>
              </button>
            )
          })
        ) : (
          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
            {translate('auto.components.TaskPage.linearNoLabelsFound', 'No labels found')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
