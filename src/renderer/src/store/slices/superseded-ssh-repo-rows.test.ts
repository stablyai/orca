import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { mergeSshRepoReadoptions, reconcileReadoptedSshRepoRows } from './superseded-ssh-repo-rows'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'r',
    path: '/p',
    displayName: 'r',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

const readoption = {
  oldTargetId: 'ssh-old',
  newTargetId: 'ssh-new',
  repoIds: ['shared']
}

describe('reconcileReadoptedSshRepoRows', () => {
  it('drops only the exact old-host row after the new-host row arrives', () => {
    const local = repo({ id: 'shared', path: '/local' })
    const oldSsh = repo({ id: 'shared', connectionId: 'ssh-old' })
    const newSsh = repo({ id: 'shared', connectionId: 'ssh-new' })

    const result = reconcileReadoptedSshRepoRows([local, oldSsh, newSsh], [readoption])

    expect(result.repos).toEqual([local, newSsh])
    expect(result.pendingReadoptions).toEqual([])
  })

  it('keeps evidence pending when repos:changed has not delivered the new row yet', () => {
    const oldSsh = repo({ id: 'shared', connectionId: 'ssh-old' })

    const result = reconcileReadoptedSshRepoRows([oldSsh], [readoption])

    expect(result.repos).toEqual([oldSsh])
    expect(result.pendingReadoptions).toEqual([readoption])
  })

  it('keeps a removed SSH ghost when a local repo shares its UUID without evidence', () => {
    const repos = [repo({ id: 'shared' }), repo({ id: 'shared', connectionId: 'ssh-old' })]

    expect(reconcileReadoptedSshRepoRows(repos, []).repos).toEqual(repos)
  })

  it('does not accept a local or runtime sibling as the mapped new SSH row', () => {
    const oldSsh = repo({ id: 'shared', connectionId: 'ssh-old' })
    const local = repo({ id: 'shared' })
    const runtime = repo({
      id: 'shared',
      connectionId: 'ssh-new',
      executionHostId: 'runtime:env-1'
    })

    const result = reconcileReadoptedSshRepoRows([oldSsh, local, runtime], [readoption])

    expect(result.repos).toEqual([oldSsh, local, runtime])
    expect(result.pendingReadoptions).toEqual([readoption])
  })

  it('leaves unrelated same-UUID SSH rows untouched', () => {
    const other = repo({ id: 'shared', connectionId: 'ssh-other' })
    const newSsh = repo({ id: 'shared', connectionId: 'ssh-new' })

    const result = reconcileReadoptedSshRepoRows([other, newSsh], [readoption])

    expect(result.repos).toEqual([other, newSsh])
  })
})

describe('mergeSshRepoReadoptions', () => {
  it('combines repo ids for the same old-to-new migration', () => {
    const result = mergeSshRepoReadoptions(
      [{ ...readoption, repoIds: ['a'] }],
      [{ ...readoption, repoIds: ['a', 'b'] }]
    )

    expect(result).toEqual([{ ...readoption, repoIds: ['a', 'b'] }])
  })
})
