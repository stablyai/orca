import { describe, expect, it } from 'vitest'
import type { ExecutionHostOwnerMatch } from '../../../shared/worktree-execution-host-resolution'
import type { HostAuthority } from '../../../shared/host-authority'
import { resolveOwnerWithLegacyFallback } from './worktree-runtime-owner'
import { OWNER_RESOLUTION_CASES } from './runtime-owner-alias-matrix.test-fixture'
import { LEGACY_FALLBACK_OWNER_ACCEPTANCE } from './resolve-owner-acceptance.test-fixture'
import { LEGACY_RUNTIME_OWNER_GOLDEN } from './legacy-runtime-owner-answers.test-fixture'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

function describeMatch(match: ExecutionHostOwnerMatch<HostAuthority>): string {
  if (match.kind !== 'resolved') {
    return match.kind
  }
  const { endpoint, at } = match.owner
  return `${endpoint.kind === 'self' ? 'self' : `env:${endpoint.environmentId}`}@${at}`
}

const casesWithIds = OWNER_RESOLUTION_CASES.flatMap((c) =>
  c.worktreeId === null ? [] : [{ ...c, worktreeId: c.worktreeId }]
)

// Each deliberate change from the deprecated resolver, with the design's reason (§5).
const DELIBERATE_CHANGES: Record<string, string> = {
  'twin-repo::wt': 'D77: a twin is never picked by default',
  'projected-twin::wt': 'D77',
  'folder:twin-folder': 'D77',
  'folder:group-twin-folder': 'D77',
  'rival-repo::wt': 'B: servers contest the SSH host',
  'conflict-repo::wt': 'B',
  'stale-hub-repo::wt': 'C: reached through the server whose repo row names the target'
}

describe('resolveOwnerWithLegacyFallback acceptance (round-3 design §5)', () => {
  it('pins the owner of every matrix case', () => {
    const actual = Object.fromEntries(
      casesWithIds.map((c) => [
        c.name,
        describeMatch(resolveOwnerWithLegacyFallback(c.state, { workspaceId: c.worktreeId }))
      ])
    )
    expect(actual).toEqual(LEGACY_FALLBACK_OWNER_ACCEPTANCE)
  })

  it('differs from the deprecated resolver only in the deliberate cases', () => {
    const changed = casesWithIds.filter((c) => {
      const owner = resolveOwnerWithLegacyFallback(c.state, { workspaceId: c.worktreeId })
      const environmentId =
        owner.kind === 'resolved' && owner.owner.endpoint.kind === 'environment'
          ? owner.owner.endpoint.environmentId
          : null
      const legacy = LEGACY_RUNTIME_OWNER_GOLDEN[c.name]
      // Why: the deprecated environment-id reader collapsed `ambiguous` to `null`.
      return owner.kind !== 'resolved' || environmentId !== (legacy === 'ambiguous' ? null : legacy)
    })
    for (const c of changed) {
      expect(DELIBERATE_CHANGES[c.worktreeId], c.name).toBeDefined()
    }
    expect(new Set(changed.map((c) => c.worktreeId))).toEqual(
      new Set(Object.keys(DELIBERATE_CHANGES))
    )
  })
})

describe('resolveOwnerWithLegacyFallback probes', () => {
  const base = OWNER_RESOLUTION_CASES.find((c) => c.name === 'focused | stale-hub-repo::wt')!.state
  const single = OWNER_RESOLUTION_CASES.find(
    (c) => c.name === 'single focus | legacy-repo::wt'
  )!.state
  const ownerOf = (state: WorktreeRuntimeOwnerState, workspaceId: string, hostId?: 'local') =>
    describeMatch(resolveOwnerWithLegacyFallback(state, { workspaceId, hostId }))

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

  it('sends a known unstamped repo with no worktree row to the single focused runtime, as spawn does', () => {
    const noWorktreeRow = {
      ...single,
      worktreesByRepo: { ...single.worktreesByRepo, 'legacy-repo': [] }
    }
    expect(ownerOf(noWorktreeRow, 'legacy-repo::wt')).toBe('env:focused-env@local')
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
