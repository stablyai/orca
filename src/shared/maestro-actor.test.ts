import { describe, expect, it } from 'vitest'
import {
  canConsumeMaestroIntent,
  canRequestMaestroIntent,
  type MaestroPrincipal
} from './maestro-actor'

const workspace = {
  repository_id: 'repo-1',
  execution_host_id: 'ssh:host-1',
  workspace_key: 'folder:folder-1',
  run_id: 'run-1'
}
const coordinator: MaestroPrincipal = {
  actor_id: 'coordinator-1',
  kind: 'coordinator',
  authenticated: true,
  session_id: 'session-1',
  generation: 3,
  workspace: {
    execution_host_id: workspace.execution_host_id,
    workspace_key: workspace.workspace_key,
    run_id: workspace.run_id
  }
}

describe('Maestro actor authority', () => {
  it('allows requests only inside the principal workspace', () => {
    expect(canRequestMaestroIntent(coordinator, workspace)).toBe(true)
    expect(
      canRequestMaestroIntent(coordinator, { ...workspace, workspace_key: 'folder:folder-2' })
    ).toBe(false)
    expect(canRequestMaestroIntent(coordinator, { ...workspace, run_id: 'run-2' })).toBe(false)
  })

  it('fences intent consumption by generation and run', () => {
    expect(canConsumeMaestroIntent(coordinator, workspace, 3)).toBe(true)
    expect(canConsumeMaestroIntent(coordinator, workspace, 4)).toBe(false)
    expect(canConsumeMaestroIntent(coordinator, { ...workspace, run_id: 'run-2' }, 3)).toBe(false)
  })
})
