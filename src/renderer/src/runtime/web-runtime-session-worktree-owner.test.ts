import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { Repo } from '../../../shared/repo-types'
import { makeWorktree } from '../components/automations/automations-page-fixtures'
import { repoWithFetchedOwner } from '../store/repos/owner-routing'
import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { worktreeSelectionOwnerForRow } from '../lib/worktree-selection-owner'
import { admitsWebRuntimeSessionWorktreeSnapshot } from './web-runtime-session-worktree-owner'

const id = 'repo-owner::/repo/checkout'
const repo: Repo = {
  id: 'repo-owner',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  executionHostId: 'ssh:shared',
  connectionId: 'shared'
}
const repos = ['publisher-a', 'publisher-b'].map((environmentId) =>
  repoWithFetchedOwner(repo, { kind: 'environment', environmentId })
)
const identity = createWorktreeIdentity({
  worktreeId: id,
  executionHostId: 'ssh:shared',
  instanceId: randomUUID()
})
const row = makeWorktree({
  id,
  repoId: repo.id,
  path: '/repo/checkout',
  hostId: 'ssh:shared',
  instanceId: identity.instanceId,
  identity
})
const snapshot = {
  worktree: id,
  publicationEpoch: 'legacy-host',
  snapshotVersion: 1,
  tabs: [],
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null
}

function stateForRows(selectedRepos = repos, rows = [row]) {
  return {
    activeWorktreeId: null,
    repos: selectedRepos,
    worktreesByRepo: { [repo.id]: rows },
    detectedWorktreesByRepo: {}
  }
}

describe('identity-less inventory retains known catalog ownership evidence', () => {
  it('refuses a known raw row when two publisher sources prevent owner capture', () => {
    const state = stateForRows()
    expect(worktreeSelectionOwnerForRow(row, state.repos)).toBeNull()
    expect(admitsWebRuntimeSessionWorktreeSnapshot(state, 'publisher-a', snapshot)).toBe(false)
  })

  it('retains the legacy fallback for a genuinely absent catalog', () => {
    expect(
      admitsWebRuntimeSessionWorktreeSnapshot(stateForRows(repos, []), 'publisher-a', snapshot)
    ).toBe(true)
  })

  it('accepts a unique matching publisher and raw owner from an older host', () => {
    const state = stateForRows(repos.slice(0, 1))
    expect(worktreeSelectionOwnerForRow(row, state.repos)).toMatchObject({
      publisherHostId: 'runtime:publisher-a',
      executionHostId: 'ssh:shared'
    })
    expect(admitsWebRuntimeSessionWorktreeSnapshot(state, 'publisher-a', snapshot)).toBe(true)
  })

  it('refuses a known publisher-B row in a publisher-A legacy inventory', () => {
    const state = stateForRows(repos.slice(1))
    expect(worktreeSelectionOwnerForRow(row, state.repos)).toMatchObject({
      publisherHostId: 'runtime:publisher-b'
    })
    expect(admitsWebRuntimeSessionWorktreeSnapshot(state, 'publisher-a', snapshot)).toBe(false)
  })

  it.each([false, true])(
    'retains an uncapturable row beside a matching owner, reversed:%s',
    (reversed) => {
      const validIdentity = createWorktreeIdentity({
        worktreeId: id,
        executionHostId: 'ssh:valid',
        instanceId: randomUUID()
      })
      const valid = withRepoHostOwnership(
        makeWorktree({
          ...row,
          hostId: 'ssh:valid',
          instanceId: validIdentity.instanceId,
          identity: validIdentity
        }),
        'runtime:publisher-a'
      )
      const validRepo = repoWithFetchedOwner(
        { ...repo, executionHostId: 'ssh:valid', connectionId: 'valid' },
        { kind: 'environment', environmentId: 'publisher-a' }
      )
      const state = stateForRows([...repos, validRepo], reversed ? [valid, row] : [row, valid])
      expect(worktreeSelectionOwnerForRow(row, state.repos)).toBeNull()
      expect(worktreeSelectionOwnerForRow(valid, state.repos)).toMatchObject({
        publisherHostId: 'runtime:publisher-a',
        executionHostId: 'ssh:valid'
      })
      expect(admitsWebRuntimeSessionWorktreeSnapshot(state, 'publisher-a', snapshot)).toBe(false)
      expect(
        admitsWebRuntimeSessionWorktreeSnapshot(
          stateForRows(state.repos, [valid]),
          'publisher-a',
          snapshot
        )
      ).toBe(true)
    }
  )

  it('filters a separately captured foreign publisher without losing the matching owner', () => {
    const matching = withRepoHostOwnership(row, 'runtime:publisher-a')
    const foreign = withRepoHostOwnership(row, 'runtime:publisher-b')
    const state = stateForRows(repos, [matching, foreign])
    expect(worktreeSelectionOwnerForRow(matching, repos)?.publisherHostId).toBe(
      'runtime:publisher-a'
    )
    expect(worktreeSelectionOwnerForRow(foreign, repos)?.publisherHostId).toBe(
      'runtime:publisher-b'
    )
    expect(admitsWebRuntimeSessionWorktreeSnapshot(state, 'publisher-a', snapshot)).toBe(true)
  })
})
