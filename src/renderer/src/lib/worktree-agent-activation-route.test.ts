import { describe, expect, it } from 'vitest'
import {
  worktreeAgentActivationRouteKey,
  type WorktreeAgentActivationRoute
} from './worktree-agent-activation-route'

const LOCAL_ROUTE: WorktreeAgentActivationRoute = {
  workspaceKey: 'repo::/worktree',
  executionHostId: 'local',
  runtimeEnvironmentId: null,
  runtimeEnvironmentRevision: null
}

describe('worktree agent activation route', () => {
  it('includes workspace, execution host, runtime, and pairing revision in the dedupe key', () => {
    const keys = [
      LOCAL_ROUTE,
      { ...LOCAL_ROUTE, executionHostId: 'ssh:box' as const },
      {
        ...LOCAL_ROUTE,
        executionHostId: 'runtime:environment-1' as const,
        runtimeEnvironmentId: 'environment-1',
        runtimeEnvironmentRevision: 1
      },
      {
        ...LOCAL_ROUTE,
        executionHostId: 'runtime:environment-1' as const,
        runtimeEnvironmentId: 'environment-1',
        runtimeEnvironmentRevision: 2
      }
    ].map(worktreeAgentActivationRouteKey)

    expect(new Set(keys).size).toBe(4)
  })
})
