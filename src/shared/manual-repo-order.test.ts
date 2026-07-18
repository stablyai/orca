import { describe, expect, it } from 'vitest'
import type { ManualRepoOrderEntry, Repo } from './types'
import {
  applyManualRepoOrder,
  getManualRepoOrder,
  normalizeManualRepoOrder
} from './manual-repo-order'

function repo(id: string, hostId: Repo['executionHostId']): Repo {
  return {
    id,
    path: `/${hostId}/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: hostId
  }
}

const localAlpha = repo('alpha', 'local')
const localBravo = repo('bravo', 'local')
const remoteCharlie = repo('charlie', 'runtime:node-b')
const remoteDelta = repo('delta', 'runtime:node-b')

describe('manual repo order', () => {
  it('preserves source order when no overlay exists', () => {
    expect(applyManualRepoOrder([localBravo, localAlpha], [])).toEqual([localBravo, localAlpha])
  })

  it('restores a host-qualified cross-host interleaving', () => {
    const order = getManualRepoOrder([localAlpha, remoteCharlie, localBravo, remoteDelta])

    expect(
      applyManualRepoOrder([remoteCharlie, remoteDelta, localAlpha, localBravo], order)
    ).toEqual([localAlpha, remoteCharlie, localBravo, remoteDelta])
  })

  it('places a late host into its saved positions', () => {
    const order = getManualRepoOrder([localAlpha, remoteCharlie, localBravo, remoteDelta])
    const localOnly = applyManualRepoOrder([localBravo, localAlpha], order)

    expect(applyManualRepoOrder([...localOnly, remoteDelta, remoteCharlie], order)).toEqual([
      localAlpha,
      remoteCharlie,
      localBravo,
      remoteDelta
    ])
  })

  it('distinguishes duplicate bare repo ids on different hosts', () => {
    const local = repo('same-id', 'local')
    const remote = repo('same-id', 'runtime:node-b')
    const order = getManualRepoOrder([remote, local])

    expect(applyManualRepoOrder([local, remote], order)).toEqual([remote, local])
  })

  it('appends unranked repos in their source order', () => {
    const newOne = repo('new-one', 'local')
    const newTwo = repo('new-two', 'runtime:node-b')
    const order = getManualRepoOrder([remoteCharlie, localAlpha])

    expect(applyManualRepoOrder([newTwo, localAlpha, newOne, remoteCharlie], order)).toEqual([
      remoteCharlie,
      localAlpha,
      newTwo,
      newOne
    ])
  })

  it('normalizes malformed, invalid-host, and duplicate entries', () => {
    const value = [
      null,
      { hostId: 'bogus', repoId: 'bad-host' },
      { hostId: 'local', repoId: '' },
      { hostId: 'runtime:node-b', repoId: 'same-id' },
      { hostId: 'runtime:node-b', repoId: 'same-id' },
      { hostId: 'local', repoId: 'same-id' }
    ] as unknown as ManualRepoOrderEntry[]

    expect(normalizeManualRepoOrder(value)).toEqual([
      { hostId: 'runtime:node-b', repoId: 'same-id' },
      { hostId: 'local', repoId: 'same-id' }
    ])
  })
})
