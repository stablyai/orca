import React from 'react'
import { ChevronRight, CircleCheck, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationRunWarning } from '../../../../shared/automation-run-result-types'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from './automation-page-parts'
import { AutomationRunOutputRow, type AutomationRunOutputActions } from './AutomationRunOutputRow'

export type { AutomationRunOutputActions } from './AutomationRunOutputRow'

export function AutomationRunSectionLabel({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn(AUTOMATION_EDITOR_SECTION_LABEL_CLASS, 'mb-2 text-muted-foreground')}>
      {children}
    </div>
  )
}

function WarningRow({ warning }: { warning: AutomationRunWarning }): React.JSX.Element {
  const resolved = warning.resolvedAt !== null
  return (
    <li className={cn('flex gap-2 px-3 py-2.5', resolved && 'text-muted-foreground')}>
      {resolved ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0" />
      ) : (
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <div className={cn('font-medium', !resolved && 'text-foreground')}>{warning.message}</div>
        {warning.impact ? <div className="text-muted-foreground">{warning.impact}</div> : null}
        {resolved ? (
          <div className="text-xs">
            {warning.resolution
              ? translate(
                  'auto.components.automations.AutomationRunResults.resolvedWith',
                  'Resolved: {{resolution}}',
                  { resolution: warning.resolution }
                )
              : translate('auto.components.automations.AutomationRunResults.resolved', 'Resolved')}
          </div>
        ) : null}
        {warning.evidence ? (
          <details className="group text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              {translate('auto.components.automations.AutomationRunResults.evidence', 'Details')}
            </summary>
            <p className="scrollbar-sleek mt-1 max-h-48 overflow-auto pl-4 break-words whitespace-pre-wrap text-muted-foreground">
              {warning.evidence}
            </p>
          </details>
        ) : null}
      </div>
    </li>
  )
}

/** Agent-reported warnings and attached files; neither proves the run succeeded. */
export function AutomationRunResults({
  run,
  actions,
  className
}: {
  run: AutomationRun
  actions: AutomationRunOutputActions
  className?: string
}): React.JSX.Element | null {
  const warnings = run.warnings ?? []
  const outputs = run.outputs ?? []
  const silent =
    run.resultReporting === 'offered' && run.status === 'completed' && warnings.length === 0
  if (warnings.length === 0 && outputs.length === 0 && !silent) {
    return null
  }
  // Open problems first; recovered ones stay as history below them.
  const ordered = warnings.toSorted(
    (left, right) => Number(left.resolvedAt !== null) - Number(right.resolvedAt !== null)
  )
  return (
    <div className={cn('space-y-8', className)}>
      {warnings.length > 0 ? (
        <section>
          <AutomationRunSectionLabel>
            {translate('auto.components.automations.AutomationRunResults.warnings', 'Warnings')}
          </AutomationRunSectionLabel>
          <ul className="divide-y divide-border/50 rounded-lg bg-[color-mix(in_srgb,var(--muted)_60%,var(--background))]">
            {ordered.map((warning) => (
              <WarningRow key={warning.key} warning={warning} />
            ))}
          </ul>
        </section>
      ) : silent ? (
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationRunResults.noWarningsReported',
            'No warnings reported.'
          )}
        </div>
      ) : null}
      {outputs.length > 0 ? (
        <section>
          <AutomationRunSectionLabel>
            {translate(
              'auto.components.automations.AutomationRunResults.attachments',
              'Attachments'
            )}
          </AutomationRunSectionLabel>
          <ul className="space-y-3">
            {outputs.map((output) => (
              <AutomationRunOutputRow key={output.id} output={output} actions={actions} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
