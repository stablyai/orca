import { describe, expect, it } from 'vitest'
import {
  ambiguousWorkspaceOwnerMessage,
  duplicatePairedServerNames,
  findDuplicatePairedServersForWorkspace
} from './duplicate-paired-servers'
import { WORKTREE_REMOVAL_AMBIGUOUS_ERROR } from '@/store/slices/worktrees/listing/worktree-slice-constants'

const WORKSPACE = 'repo-1::/srv/app'
const studio = { id: 'env-a', name: 'Studio', hostKeyFingerprint: 'key-1' }
const studioRelay = { id: 'env-b', name: 'Studio relay', hostKeyFingerprint: 'key-1' }
const laptop = { id: 'env-c', name: 'Laptop', hostKeyFingerprint: 'key-2' }

type OwnerRow = { id: string; hostId: string; runtimeOwnerEnvironmentId?: string }

// Each server proxies the same SSH target, so both publish an `ssh:box` row for the workspace.
function stateWith(environments: (typeof studio)[], publishers: string[]) {
  return {
    runtimeEnvironments: environments,
    worktreesByRepo: {
      'repo-1': publishers.map((environmentId): OwnerRow => ({
        id: WORKSPACE,
        hostId: 'ssh:box',
        runtimeOwnerEnvironmentId: environmentId
      }))
    }
  }
}

describe('a server paired twice', () => {
  it('names both entries when they share a host key and both publish the workspace', () => {
    const state = stateWith([studio, studioRelay, laptop], ['env-a', 'env-b'])
    expect(findDuplicatePairedServersForWorkspace(state, WORKSPACE)).toEqual([
      'Studio',
      'Studio relay'
    ])
    expect(ambiguousWorkspaceOwnerMessage(state, WORKSPACE)).toBe(
      'Studio and Studio relay are the same server paired twice. Remove one in Settings > Remote Orca Servers.'
    )
  })

  it('keeps the generic message when two different servers publish the workspace', () => {
    const state = stateWith([studio, laptop], ['env-a', 'env-c'])
    expect(findDuplicatePairedServersForWorkspace(state, WORKSPACE)).toBeNull()
    expect(ambiguousWorkspaceOwnerMessage(state, WORKSPACE)).toBe(WORKTREE_REMOVAL_AMBIGUOUS_ERROR)
  })

  it('keeps the generic message when another host publishes it too, since removing a twin would not help', () => {
    const withLaptop = stateWith([studio, studioRelay, laptop], ['env-a', 'env-b', 'env-c'])
    expect(findDuplicatePairedServersForWorkspace(withLaptop, WORKSPACE)).toBeNull()
    const withLocal = stateWith([studio, studioRelay], ['env-a', 'env-b'])
    withLocal.worktreesByRepo['repo-1'].push({ id: WORKSPACE, hostId: 'local' })
    expect(findDuplicatePairedServersForWorkspace(withLocal, WORKSPACE)).toBeNull()
  })

  it('keeps the generic message when the twins proxy two targets holding the same id', () => {
    const state = stateWith([studio, studioRelay], [])
    for (const hostId of ['ssh:box', 'ssh:other-box']) {
      for (const runtimeOwnerEnvironmentId of ['env-a', 'env-b']) {
        state.worktreesByRepo['repo-1'].push({ id: WORKSPACE, hostId, runtimeOwnerEnvironmentId })
      }
    }
    expect(findDuplicatePairedServersForWorkspace(state, WORKSPACE)).toBeNull()
  })

  it('reads an unstamped folder through the project group both twins publish', () => {
    const state = {
      runtimeEnvironments: [studio, studioRelay],
      folderWorkspaces: [{ id: 'f1', projectGroupId: 'g1' }],
      projectGroups: [
        { id: 'g1', executionHostId: 'runtime:env-a' },
        { id: 'g1', executionHostId: 'runtime:env-b' }
      ]
    }
    expect(findDuplicatePairedServersForWorkspace(state, 'folder:f1')).toEqual([
      'Studio',
      'Studio relay'
    ])
  })

  it('keeps the generic message when only one of the twins publishes the workspace', () => {
    const state = stateWith([studio, studioRelay], ['env-a'])
    expect(ambiguousWorkspaceOwnerMessage(state, WORKSPACE)).toBe(WORKTREE_REMOVAL_AMBIGUOUS_ERROR)
  })

  it('never pairs servers whose host key is unknown', () => {
    const keyless = [
      { id: 'env-a', name: 'A' },
      { id: 'env-b', name: 'B' }
    ]
    expect(
      findDuplicatePairedServersForWorkspace(
        { ...stateWith([], ['env-a', 'env-b']), runtimeEnvironments: keyless },
        WORKSPACE
      )
    ).toBeNull()
    expect(duplicatePairedServerNames(keyless, 'env-a')).toEqual([])
  })

  it('reads a folder workspace published on both servers', () => {
    const state = {
      runtimeEnvironments: [studio, studioRelay],
      folderWorkspaces: [
        { id: 'f1', executionHostId: 'runtime:env-a' },
        { id: 'f1', executionHostId: 'runtime:env-b' }
      ]
    }
    expect(findDuplicatePairedServersForWorkspace(state, 'folder:f1')).toEqual([
      'Studio',
      'Studio relay'
    ])
  })

  it('lists the twins of one entry for its Settings row', () => {
    expect(duplicatePairedServerNames([studio, studioRelay, laptop], 'env-a')).toEqual([
      'Studio relay'
    ])
    expect(duplicatePairedServerNames([studio, studioRelay, laptop], 'env-c')).toEqual([])
  })
})
