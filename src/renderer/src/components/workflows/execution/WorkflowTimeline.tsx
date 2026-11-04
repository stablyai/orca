import React, { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type {
  WorkflowEvent,
  WorkflowEventKind,
  WorkflowRun
} from '../../../../../shared/workflow/workflow-run-types'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import { getIntlLocale, translate } from '@/i18n/i18n'

const TONE: Partial<Record<WorkflowEventKind, string>> = {
  'run-completed': 'bg-status-success',
  'task-completed': 'bg-status-success',
  'run-failed': 'bg-destructive',
  'task-failed': 'bg-destructive',
  'agent-start-failed': 'bg-destructive',
  'message-rejected': 'bg-destructive',
  'task-unknown': 'bg-muted-foreground',
  'approval-requested': 'bg-status-warning',
  'message-held': 'bg-status-warning',
  'question-received': 'bg-status-warning',
  'escalation-received': 'bg-status-warning',
  warning: 'bg-status-warning',
  'agent-started': 'bg-agent-working',
  'agent-dispatched': 'bg-agent-working'
}

function time(at: string): string {
  return new Date(at).toLocaleTimeString(getIntlLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function WorkflowTimeline({
  run,
  onlyErrors = false
}: {
  run: WorkflowRun
  onlyErrors?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const select = useWorkflowEditorStore((state) => state.select)
  const labels = useMemo(
    () => new Map(run.definition.nodes.map((node) => [node.id, node.label])),
    [run.definition.nodes]
  )
  const events = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return run.events
      .filter(
        (event) =>
          !onlyErrors ||
          [
            'run-failed',
            'task-failed',
            'agent-start-failed',
            'message-rejected',
            'task-unknown',
            'warning'
          ].includes(event.kind)
      )
      .filter(
        (event) =>
          !needle ||
          `${event.kind} ${event.message} ${labels.get(event.nodeId ?? '') ?? ''}`
            .toLowerCase()
            .includes(needle)
      )
      .toReversed()
  }, [run.events, query, onlyErrors, labels])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate(
            'auto.components.workflows.execution.WorkflowTimeline.afb7b6ff5f',
            'Filter events'
          )}
          density="compact"
          className="max-w-64"
        />
        <span className="text-2xs text-muted-foreground">
          {events.length}{' '}
          {translate('auto.components.workflows.execution.WorkflowTimeline.1284214df1', 'of')}{' '}
          {run.events.length}
        </span>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {events.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            {onlyErrors
              ? translate(
                  'auto.components.workflows.execution.WorkflowTimeline.19fac95c3c',
                  'No errors or warnings recorded.'
                )
              : translate(
                  'auto.components.workflows.execution.WorkflowTimeline.3b7a1d1bed',
                  'No events yet.'
                )}
          </li>
        ) : null}
        {events.map((event: WorkflowEvent) => (
          <li key={event.seq}>
            <button
              type="button"
              onClick={() => event.nodeId && select({ kind: 'nodes', ids: [event.nodeId] })}
              className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left hover:bg-accent"
            >
              <span className="w-20 shrink-0 whitespace-nowrap pt-px font-mono text-2xs tabular-nums text-muted-foreground">
                {time(event.at)}
              </span>
              <span
                className={cn(
                  'mt-1.5 size-1.5 shrink-0 rounded-full',
                  TONE[event.kind] ?? 'bg-muted-foreground/50'
                )}
                aria-hidden
              />
              <span className="w-36 shrink-0 truncate text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                {event.kind.replaceAll('-', ' ')}
              </span>
              <span className="min-w-0 flex-1 text-xs leading-5">{event.message}</span>
              {event.orcaDispatchId ? (
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  {event.orcaDispatchId}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
