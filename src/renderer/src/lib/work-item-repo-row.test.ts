import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { getWorkItemRepo } from './work-item-repo-row'

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1
}
const sshRow: Repo = { ...localRow, path: '/remote/twin', connectionId: 'builder' }
const runtimeRow: Repo = { ...localRow, executionHostId: 'runtime:env-1' }

describe('getWorkItemRepo (GitHub and GitLab items)', () => {
  it('picks the twin on the stamped host', () => {
    expect(getWorkItemRepo([sshRow, localRow], { repoId: 'twin', repoHostId: 'ssh:builder' })).toBe(
      sshRow
    )
  })

  it('refuses a twin whose stamped host has no row', () => {
    expect(
      getWorkItemRepo([sshRow, localRow], { repoId: 'twin', repoHostId: 'runtime:gone' })
    ).toBeUndefined()
  })

  it('keeps a lone row even when the fetch stamped the source host', () => {
    expect(getWorkItemRepo([runtimeRow], { repoId: 'twin', repoHostId: 'local' })).toBe(runtimeRow)
  })

  it('keeps the by-id row for an unstamped item', () => {
    expect(getWorkItemRepo([sshRow, localRow], { repoId: 'twin' })).toBe(localRow)
  })
})
