import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { reconcileReadoptedSshRepoRows } from './superseded-ssh-repo-rows'

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
})
