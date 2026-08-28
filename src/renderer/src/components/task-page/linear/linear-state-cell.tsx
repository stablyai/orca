import React, { useCallback, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  getLinearStateMarkerStyle,
  getLinearStatePillStyle
} from '@/components/linear-state-pill-style'
import { useTeamStates } from '@/hooks/useIssueMetadata'
import { linearUpdateIssue } from '@/runtime/runtime-linear-issue-mutations'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function LinearStateCell({
  issue,
  className,
  sourceContext
}: {
  issue: LinearIssue
  className?: string
  sourceContext?: TaskSourceContext | null
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const states = useTeamStates(issue.team.id, providerSettings, issue.workspaceId)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const reqRef = useRef(0)

  const currentStateId = states.data.find(
    (s) => s.name === issue.state.name && s.type === issue.state.type
  )?.id

  const handleStateChange = useCallback(
    (stateId: string) => {
      const newState = states.data.find((s) => s.id === stateId)
      if (!newState || stateId === currentStateId || pending) {
        return
      }

      reqRef.current += 1
      const reqId = reqRef.current
      const previousState = issue.state
      const nextState: LinearIssue['state'] = {
        name: newState.name,
        type: newState.type,
        color: newState.color
      }

      setPending(true)
      patchLinearIssue(issue.id, { state: nextState }, { sourceContext })
      void linearUpdateIssue(providerSettings, issue.id, { stateId }, issue.workspaceId)
        .then((result) => {
          if (reqId !== reqRef.current) {
            return
          }
          if (result.ok === false) {
            patchLinearIssue(issue.id, { state: previousState }, { sourceContext })
            toast.error(
              result.error ??
                translate('auto.components.TaskPage.6775c05483', 'Failed to update Linear state')
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
          patchLinearIssue(issue.id, { state: previousState }, { sourceContext })
          toast.error(
            translate('auto.components.TaskPage.6775c05483', 'Failed to update Linear state')
          )
        })
        .finally(() => {
          if (reqId === reqRef.current) {
            setPending(false)
          }
        })
    },
    [
      currentStateId,
      issue.id,
      issue.state,
      issue.workspaceId,
      patchLinearIssue,
      pending,
      providerSettings,
      sourceContext,
      states.data
    ]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex min-w-0 cursor-pointer! items-center gap-1 rounded-full border text-[11px] font-medium transition-[background-color,border-color,color,box-shadow] hover:[--linear-state-pill-current-background:var(--linear-state-pill-hover-background)] hover:[--linear-state-pill-current-border:var(--linear-state-pill-hover-border)] hover:[--linear-state-pill-current-foreground:var(--linear-state-pill-hover-foreground)] hover:ring-1 hover:ring-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default! disabled:opacity-80 [&_*]:cursor-pointer! disabled:[&_*]:cursor-default!',
            className
          )}
          style={{
            ...getLinearStatePillStyle(issue.state.color),
            cursor: pending ? 'default' : 'pointer'
          }}
          aria-label={translate(
            'auto.components.TaskPage.d45a910c4a',
            'Change Linear state from {{value0}}',
            { value0: issue.state.name }
          )}
          aria-busy={pending || states.loading}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={getLinearStateMarkerStyle(issue.state.color)}
          />
          <span className="truncate">{issue.state.name}</span>
          {pending || states.loading ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin opacity-70" />
          ) : (
            <ChevronDown className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="popover-scroll-content scrollbar-sleek w-48 p-1"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        {states.error ? (
          <div className="px-2 py-3 text-center text-[12px] text-destructive">{states.error}</div>
        ) : states.loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            {translate('auto.components.TaskPage.cc13109b5d', 'Loading states')}
          </div>
        ) : states.data.length > 0 ? (
          states.data.map((state) => (
            <button
              key={state.id}
              type="button"
              onClick={() => {
                handleStateChange(state.id)
                setOpen(false)
              }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                currentStateId === state.id && 'bg-accent/50'
              )}
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: state.color }}
              />
              {state.name}
            </button>
          ))
        ) : (
          <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
            {translate('auto.components.TaskPage.afc68824ff', 'No states found')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
