import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { indexTaskNodes } from '@/lib/orchestrator-task-row'
import { MissionControlTaskRow } from './MissionControlTaskRow'
import type { OrchestrationRunDag } from '../../../../shared/runtime-types'

// Why (#7 O2): the live task DAG section of Mission Control — renders one row per
// task in the coordinator's run, replacing the lineage-only "Spawned work" view
// when a coordinator run exists. Kept in its own file so the parent component
// stays under the line cap (AGENTS.md).
export function MissionControlTasksSection({
  dag
}: {
  dag: OrchestrationRunDag
}): React.JSX.Element {
  const nodesById = useMemo(() => indexTaskNodes(dag), [dag])

  return (
    <div className="px-2 py-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.right.sidebar.OrchestratorMissionControl.tasks', 'Tasks')}
        </span>
        {dag.tasks.length > 0 ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">{dag.tasks.length}</span>
        ) : null}
      </div>

      {dag.tasks.length === 0 ? (
        <p className="px-1 py-2 text-xs leading-relaxed text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.OrchestratorMissionControl.tasks_empty',
            'No tasks yet — the coordinator decomposes the work as it plans.'
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {dag.tasks.map((node) => (
            <MissionControlTaskRow key={node.id} node={node} nodesById={nodesById} />
          ))}
        </div>
      )}

      {dag.truncatedTaskCount > 0 ? (
        <p className="px-1 pt-1.5 text-[11px] leading-snug text-muted-foreground/80">
          {translate(
            'auto.components.right.sidebar.OrchestratorMissionControl.tasks_truncated',
            '+{{value0}} more task(s) not shown',
            { value0: dag.truncatedTaskCount }
          )}
        </p>
      ) : null}
    </div>
  )
}
