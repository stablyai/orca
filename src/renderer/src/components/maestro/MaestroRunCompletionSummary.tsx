import { CheckCircle2 } from 'lucide-react'
import type { MaestroRunProgressV2 } from '../../../../shared/maestro-run-progress'
import { translate } from '@/i18n/i18n'

type RunCompletion = NonNullable<MaestroRunProgressV2['completion']>

export function MaestroRunCompletionSummary({
  completion
}: {
  completion: RunCompletion
}): React.JSX.Element {
  return (
    <section className="space-y-2 border-b border-border pb-3" data-maestro-run-completion="">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <CheckCircle2 className="size-3.5 text-muted-foreground" />
        {translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.runCompletion',
          'Run completion'
        )}
      </div>
      <p className="text-xs leading-5 text-foreground">{completion.summary}</p>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.maestro.MaestroWorkspaceHarnessOverlay.completionAuthority',
          'Completed by {{value0}}, coordinator generation {{value1}}',
          {
            value0: completion.completed_by.handle,
            value1: completion.completed_by.generation
          }
        )}
      </p>
      <div className="space-y-1 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground">
          {translate(
            'auto.components.maestro.MaestroWorkspaceHarnessOverlay.completionEvidence',
            'Evidence'
          )}
        </p>
        <ul className="list-disc space-y-0.5 pl-4">
          {completion.evidence.map((entry, index) => (
            <li key={`${index}:${entry}`}>{entry}</li>
          ))}
        </ul>
      </div>
      {completion.waivers.length ? (
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p className="font-medium text-foreground">
            {translate(
              'auto.components.maestro.MaestroWorkspaceHarnessOverlay.completionWaivers',
              'Explicit waivers'
            )}
          </p>
          <ul className="space-y-1">
            {completion.waivers.map((waiver) => (
              <li key={waiver.task_id}>
                <span className="font-mono text-foreground">{waiver.task_id}</span>: {waiver.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
