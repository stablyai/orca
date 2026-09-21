import type { ProjectCoordination, ProjectUpdateArgs } from './project-types'
import { ProjectUpdate } from './rpc-contract/project-runtime-params'

export const PROJECT_COORDINATION_CONFLICT_CODE = 'project_coordination_conflict' as const

export class ProjectCoordinationConflictError extends Error {
  readonly code = PROJECT_COORDINATION_CONFLICT_CODE

  constructor() {
    super('Project instructions changed. Reload before saving your changes.')
    this.name = 'ProjectCoordinationConflictError'
  }
}

export function applyProjectCoordinationUpdate(
  current: ProjectCoordination | undefined,
  update: NonNullable<ProjectUpdateArgs['updates']['coordination']>
): ProjectCoordination {
  const parsed = ProjectUpdate.shape.updates.shape.coordination.unwrap().parse(update)
  if (parsed.expectedRevision !== (current?.revision ?? 0)) {
    throw new ProjectCoordinationConflictError()
  }
  return {
    goal: parsed.goal,
    instructions: parsed.instructions,
    revision: parsed.expectedRevision + 1
  }
}
