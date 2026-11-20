import type { PipelineConfig, PipelineStageStatus } from './pipeline-config'

export type PipelineEvent = {
  type: string
}

export type PipelineRun = {
  issueId: string
  stages: Record<string, PipelineStageStatus>
  completed: boolean
}

export function createPipelineRun(config: PipelineConfig, issueId: string): PipelineRun {
  const stages: Record<string, PipelineStageStatus> = {}
  for (const stage of config.stages) {
    stages[stage.id] = stage.id === config.initial ? 'active' : 'idle'
  }
  return { issueId, stages, completed: false }
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
    return { issueId: run.issueId, stages, completed: true }
  }
  stages[transition.goto] = 'active'
  return { issueId: run.issueId, stages, completed: false }
}
