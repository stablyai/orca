// The acceptance-criteria coverage checklist (Phase 6).
//
// STRICTLY READ-ONLY. There is no checkbox, no click target, and no IPC call:
// coverage is durable evidence from a Codex plan audit, and the renderer has no
// channel that could mutate it. What is drawn here comes entirely from the
// server-computed projection.
//
// THE CENTRAL RULE — never render an absence as a judgement. With no qualifying
// audit, `coverageAvailable` is false and this says "not yet audited". Showing
// "0 of 3 covered" there would assert that Codex looked and found nothing, which
// nobody observed.
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

type Props = { task: AuditedTaskStatusProjection }

export function AuditedCoverageChecklist({ task }: Props): React.JSX.Element | null {
  const criteria = task.acceptanceCriteria
  // Nothing to annotate. Distinct from "audited and uncovered", which renders the
  // full list below.
  if (criteria.length === 0) {
    return null
  }

  const heading = translate(
    'auto.components.auditedWorkflow.coverage.heading',
    'Acceptance criteria'
  )

  if (!task.coverageAvailable) {
    return (
      <div className="mt-3 rounded-lg border border-border p-3">
        <p className="text-[11px] font-medium uppercase text-muted-foreground">{heading}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.auditedWorkflow.coverage.notAudited',
            'Not yet audited. Run the Codex audit to record coverage.'
          )}
        </p>
      </div>
    )
  }

  const coveredCount = criteria.filter((criterion) => criterion.covered).length

  return (
    <div className="mt-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium uppercase text-muted-foreground">{heading}</p>
        <span className="text-xs text-muted-foreground">
          {translate(
            'auto.components.auditedWorkflow.coverage.count',
            '{covered} of {total} covered'
          )
            .replace('{covered}', String(coveredCount))
            .replace('{total}', String(criteria.length))}
        </span>
      </div>

      <ul className="mt-2 flex flex-col gap-2">
        {criteria.map((criterion) => (
          <li key={criterion.id} className="flex items-start gap-2">
            <Badge variant={criterion.covered ? 'default' : 'outline'}>
              {criterion.covered
                ? translate('auto.components.auditedWorkflow.coverage.covered', 'Covered')
                : translate('auto.components.auditedWorkflow.coverage.uncovered', 'Not covered')}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm">{criterion.text}</p>
              {criterion.note ? (
                <p className="mt-0.5 break-words text-xs text-muted-foreground">{criterion.note}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
