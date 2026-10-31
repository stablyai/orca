import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { threadProjectForLocation, eligibleThreadProjects } from './thread-projects'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { AGENT_SESSION_CREATE_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'

const supports = vi.hoisted(() => vi.fn(async (_target: unknown, _capability: string) => true))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  structuredAgentSessionHostSupports: supports
}))
const repo: Repo = {
  id: 'repo',
  path: '/project',
  displayName: 'Project',
  badgeColor: '',
  addedAt: 1
}
const local = makeWorktree({
  id: 'repo::/project',
  repoId: 'repo',
  path: '/project',
  isMainWorktree: true,
  hostId: 'local'
})
const remote = { ...local, hostId: 'runtime:server' as const }
const remoteRepo = {
  ...repo,
  displayName: 'Server project',
  executionHostId: 'runtime:server' as const
}
const state = {
  repos: [repo, remoteRepo],
  worktreesByRepo: { repo: [local, remote] },
  folderWorkspaces: [],
  projectGroups: []
}

describe('thread project derivation', () => {
  it('uses the session host to distinguish identical main checkout IDs, and recomputes after removal', () => {
    expect(
      threadProjectForLocation(state, { workspaceId: local.id, executionHostId: 'local' })
    ).toBe(repo)
    expect(
      threadProjectForLocation(state, { workspaceId: local.id, executionHostId: 'runtime:server' })
    ).toBe(remoteRepo)
    expect(
      threadProjectForLocation(
        { ...state, repos: [repo] },
        { workspaceId: local.id, executionHostId: 'runtime:server' }
      )
    ).toBeNull()
    expect(
      threadProjectForLocation(state, { workspaceId: 'missing', executionHostId: 'local' })
    ).toBeNull()
    expect(
      threadProjectForLocation(
        { ...state, worktreesByRepo: { repo: [{ ...local, isMainWorktree: false }] } },
        { workspaceId: local.id, executionHostId: 'local' }
      )
    ).toBeNull()
  })

  it('offers only capable hosts, and returns no projects when none advertise thread creation', async () => {
    const store = createTestStore()
    store.setState(state)
    supports.mockImplementation(
      async (target) =>
        typeof target === 'object' && target !== null && 'kind' in target && target.kind === 'local'
    )
    expect((await eligibleThreadProjects(store.getState())).map((item) => item.repo)).toEqual([
      repo
    ])
    expect(supports).toHaveBeenCalledWith(
      { kind: 'local' },
      AGENT_SESSION_CREATE_SURFACE_RUNTIME_CAPABILITY
    )
    supports.mockResolvedValue(false)
    expect(await eligibleThreadProjects(store.getState())).toEqual([])
  })
})
