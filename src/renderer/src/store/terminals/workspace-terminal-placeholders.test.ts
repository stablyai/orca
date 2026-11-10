import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { buildRuntimeSessionPlaceholders } from './workspace-terminal-placeholders'
import { addHydratedSshWorktreePlaceholders } from './workspace-terminal-ssh-placeholders'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/one',
  displayName: 'one',
  badgeColor: DEFAULT_REPO_BADGE_COLOR,
  addedAt: 0,
  connectionId: null,
  executionHostId: 'local'
}

describe('addHydratedSshWorktreePlaceholders', () => {
  const placeholderFor = (repos: Repo[]) =>
    addHydratedSshWorktreePlaceholders(repos, {}, { 'ssh-repo::/repos/ssh': [] })['ssh-repo'][0]

  it('routes a restored, selected server-nested SSH tab through its server, not a direct dial', () => {
    const hubRepo: Repo = {
      ...repo,
      id: 'ssh-repo',
      connectionId: 'box',
      executionHostId: 'runtime:hub'
    }
    const worktreeId = 'ssh-repo::/repos/ssh'
    const owner = resolveOwner(
      {
        repos: [hubRepo],
        worktreesByRepo: { 'ssh-repo': [placeholderFor([hubRepo])] },
        detectedWorktreesByRepo: {},
        runtimeEnvironments: [{ id: 'hub' }],
        activeWorktreeId: worktreeId,
        activeWorkspaceExecutionHostId: 'ssh:box'
      },
      { workspaceId: worktreeId }
    )
    expect(owner).toEqual({
      kind: 'resolved',
      owner: { endpoint: { kind: 'environment', environmentId: 'hub' }, at: 'ssh:box' }
    })
  })
})

describe('buildRuntimeSessionPlaceholders for a server repo that nests SSH', () => {
  it('stamps the SSH target and the server instead of a bare runtime host', () => {
    const hubRepo: Repo = { ...repo, connectionId: 'box', executionHostId: 'runtime:hub' }
    const result = buildRuntimeSessionPlaceholders({
      repos: [hubRepo],
      runtimeHostIdByWorkspaceSessionKey: { 'repo-1::/srv/one': 'runtime:hub' },
      worktreesByRepo: {}
    })
    expect(result.worktreesByRepo['repo-1'][0]).toMatchObject({
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'hub'
    })
  })
})
