export type PipelineStageStatus = 'idle' | 'active' | 'pass' | 'attention'

export type PipelineTransition = {
  goto: string | null
  markCurrent?: PipelineStageStatus
}

export type PipelineStageConfig = {
  id: string
  label?: string
  on: Record<string, PipelineTransition>
}

export type PipelineConfig = {
  version: 1
  initial: string
  stages: readonly PipelineStageConfig[]
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  version: 1,
  initial: 'triage',
  stages: [
    {
      id: 'triage',
      on: {
        'triaged:auto': { goto: 'fix' },
        'triaged:manual': { goto: 'approval' }
      }
    },
    { id: 'approval', on: { approved: { goto: 'fix' } } },
    { id: 'fix', on: { 'fix:completed': { goto: 'review' } } },
    {
      id: 'review',
      on: {
        'review:passed': { goto: 'ci' },
        'review:changes-requested': { goto: 'fix', markCurrent: 'attention' }
      }
    },
    {
      id: 'ci',
      on: {
        'ci:passed': { goto: 'merge' },
        'ci:failed': { goto: 'fix', markCurrent: 'attention' }
      }
    },
    { id: 'merge', on: { merged: { goto: null } } }
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validatePipelineConfig(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) {
    return ['pipeline config must be an object']
  }
  if (value.version !== 1) {
    errors.push('pipeline config version must be 1')
  }
  if (typeof value.initial !== 'string' || value.initial.length === 0) {
    errors.push('pipeline config needs a non-empty initial stage id')
  }
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    errors.push('pipeline config needs at least one stage')
    return errors
  }
  const ids = new Set<string>()
  for (const stage of value.stages) {
    if (!isRecord(stage) || typeof stage.id !== 'string' || stage.id.length === 0) {
      errors.push('every stage needs a non-empty string id')
      continue
    }
    if (ids.has(stage.id)) {
      errors.push(`duplicate stage id: ${stage.id}`)
    }
    ids.add(stage.id)
    if (!isRecord(stage.on)) {
      errors.push(`stage ${stage.id} needs an on transition table`)
    }
  }
  if (typeof value.initial === 'string' && value.initial.length > 0 && !ids.has(value.initial)) {
    errors.push(`initial stage ${value.initial} is not defined`)
  }
  for (const stage of value.stages) {
    if (!isRecord(stage) || !isRecord(stage.on) || typeof stage.id !== 'string') {
      continue
    }
    for (const [event, transition] of Object.entries(stage.on)) {
      if (!isRecord(transition)) {
        errors.push(`stage ${stage.id} event ${event} needs a transition object`)
        continue
      }
      if (transition.goto !== null && typeof transition.goto !== 'string') {
        errors.push(`stage ${stage.id} event ${event} goto must be a stage id or null`)
      } else if (typeof transition.goto === 'string' && !ids.has(transition.goto)) {
        errors.push(`stage ${stage.id} event ${event} points at unknown stage ${transition.goto}`)
      }
    }
  }
  return errors
}

export function parsePipelineConfigText(text: string): PipelineConfig {
  const value: unknown = JSON.parse(text)
  const errors = validatePipelineConfig(value)
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
  return value as PipelineConfig
}
