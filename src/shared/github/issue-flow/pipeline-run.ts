import type { PipelineTask } from '../../pipeline/pipeline-task'
import type { PipelineConfig, PipelineStageStatus } from './pipeline-config'

export type PipelineEvent = {
  type: string
}

export type PipelineRun = {
  taskId: string
  task?: PipelineTask
  stages: Record<string, PipelineStageStatus>
  completed: boolean
}

export function createPipelineRun(
  config: PipelineConfig,
  taskOrId: string | PipelineTask
): PipelineRun {
  const stages: Record<string, PipelineStageStatus> = {}
  for (const stage of config.stages) {
    stages[stage.id] = stage.id === config.initial ? 'active' : 'idle'
  }
  if (typeof taskOrId === 'string') {
    return { taskId: taskOrId, stages, completed: false }
  }
  return { taskId: taskOrId.id, task: taskOrId, stages, completed: false }
}

export function advancePipelineRun(
  config: PipelineConfig,
  run: PipelineRun,
  event: PipelineEvent
): PipelineRun {
  if (run.completed) {
    return run
  }
  const active = config.stages.find((stage) => run.stages[stage.id] === 'active')
  const transition = active?.on[event.type]
  if (!active || !transition) {
    return run
  }
  const stages = { ...run.stages, [active.id]: transition.markCurrent ?? 'pass' }
  if (transition.goto === null) {
    return { ...run, stages, completed: true }
  }
  stages[transition.goto] = 'active'
  return { ...run, stages, completed: false }
}
