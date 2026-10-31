import { describe, expect, it } from 'vitest'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import type { HostAuthority } from '../../../shared/host-authority'
import { resolveOwnerOrLocal } from './worktree-runtime-owner'
import { OWNER_RESOLUTION_CASES } from './runtime-owner-alias-matrix.test-fixture'

import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

function describeMatch(match: ExecutionHostOwnerMatch<HostAuthority>): string {
  if (match.kind !== 'resolved') {
    return match.kind
  }
  const { endpoint, at } = match.owner
  return `${endpoint.kind === 'self' ? 'self' : `env:${endpoint.environmentId}`}@${at}`
}

describe('resolveOwnerOrLocal probes', () => {
  const base = OWNER_RESOLUTION_CASES.find((c) => c.name === 'focused | stale-hub-repo::wt')!.state
  const single = OWNER_RESOLUTION_CASES.find(
    (c) => c.name === 'single focus | legacy-repo::wt'
  )!.state
  const ownerOf = (state: WorktreeRuntimeOwnerState, workspaceId: string, hostId?: 'local') =>
    describeMatch(resolveOwnerOrLocal(state, { workspaceId, hostId }))

  it('reads a genuine twin as ambiguous', () => {
    const withDirect = {
      ...base,
      repos: [
        ...base.repos!,
        { id: 'stale-hub-repo', connectionId: 'target', executionHostId: 'ssh:target' as const }
      ]
    }
    expect(ownerOf(withDirect, 'stale-hub-repo::wt')).toBe('ambiguous')
  })

  it('keeps a row-less worktree and a setup id local under single focus, as the deprecated resolver does', () => {
    expect(ownerOf(single, 'unknown-repo::wt')).toBe('self@local')
    expect(ownerOf(single, 'onboarding-setup::/tmp/skill')).toBe('self@local')
  })

  it('keeps a known unstamped repo with no worktree row local under single focus', () => {
    const noWorktreeRow = {
      ...single,
      worktreesByRepo: { ...single.worktreesByRepo, 'legacy-repo': [] }
    }
    expect(ownerOf(noWorktreeRow, 'legacy-repo::wt')).toBe('self@local')
  })

  it('lets a named host win over the single focused runtime', () => {
    expect(ownerOf(single, 'legacy-repo::wt', 'local')).toBe('self@local')
    const activeLocal = {
      ...single,
      activeWorktreeId: 'folder:missing-folder',
      activeWorkspaceExecutionHostId: 'local' as const
    }
    expect(ownerOf(activeLocal, 'folder:missing-folder')).toBe('self@local')
  })

  it('reads a repo twin with a detected local row as the deprecated resolver does', () => {
    const withDetected = {
      ...base,
      detectedWorktreesByRepo: {
        ...base.detectedWorktreesByRepo,
        'repo-twin-only': {
          worktrees: [{ id: 'repo-twin-only::wt', repoId: 'repo-twin-only' }]
        }
      }
    }
    expect(ownerOf(withDetected, 'repo-twin-only::wt')).toBe('self@local')
  })
})
