import React from 'react'
import { translate } from '@/i18n/i18n'
import type { OrchestrationActivity } from '../../../../shared/runtime-types'

// Why (#7 O2): the director header's live summary when a coordinator run is in
// flight — the supervising/stalled word, the OrchestrationActivity counts, and
// the recipe line (present only for recipe directors). Split out to keep the
// parent component under the line cap (AGENTS.md).
export function MissionControlSupervisionSummary({
  stalled,
  activity,
  recipe
}: {
  stalled: boolean
  activity: OrchestrationActivity
  recipe: string | null
}): React.JSX.Element {
  return (
    <>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {translate(
          stalled
            ? 'auto.components.right.sidebar.OrchestratorMissionControl.supervising_stalled'
            : 'auto.components.right.sidebar.OrchestratorMissionControl.supervising',
          stalled ? 'Supervision stalled' : 'Supervising',
          {}
        )}
        {' · '}
        {/* Why (#5): this is pendingTasks (not-yet-terminal), which differs from
            the tasks-section header's total task count. Label it "outstanding"
            so the two numbers don't both read as "tasks". */}
        {translate(
          'auto.components.right.sidebar.OrchestratorMissionControl.supervising_counts',
          '{{value0}} outstanding · {{value1}} workers · {{value2}} stalled',
          {
            value0: activity.pendingTasks,
            value1: activity.activeDispatches,
            value2: activity.staleDispatches
          }
        )}
      </p>
      {recipe ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
          {translate(
            'auto.components.right.sidebar.OrchestratorMissionControl.recipe',
            'recipe: {{value0}}',
            { value0: recipe }
          )}
        </p>
      ) : null}
    </>
  )
}
