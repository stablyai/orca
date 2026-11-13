import { describe, expect, it } from 'vitest'
import {
  cloudWorkspaceActionGroups,
  type CloudWorkspaceActionInput
} from './cloud-workspace-action-groups'

const base: CloudWorkspaceActionInput = {
  surface: 'list',
  status: 'running',
  archivedAt: null,
  visibility: 'private',
  canOpen: true,
  canManage: true,
  readableAsleep: false,
  canRestart: true,
  hasMembers: true
}

const flat = (input: Partial<CloudWorkspaceActionInput>) =>
  cloudWorkspaceActionGroups({ ...base, ...input }).map((g) => `${g.id}:${g.actions.join(',')}`)

describe('one action list for every surface (JA-14)', () => {
  it('the list: Open, Share, Lifecycle, Danger in that order, with Restart', () => {
    expect(flat({})).toEqual([
      'open:open,copyLink,copyWorkspaceLink',
      'share:share,reassignOwner',
      'lifecycle:restart,sleep,archive',
      'danger:delete'
    ])
  })

  it('the sidebar gets the same Share and Lifecycle actions, minus list-only items', () => {
    expect(flat({ surface: 'sidebar', visibility: 'team' })).toEqual([
      'open:copyWorkspaceLink',
      'share:makePrivate',
      'lifecycle:restart,sleep,archive',
      'danger:delete'
    ])
  })

  it('archived: Unarchive, no Restart or Sleep', () => {
    expect(flat({ archivedAt: 1, status: 'suspended' })).toContain('lifecycle:unarchive')
  })

  it('asleep in the list reads the saved copy, and Wake is its own action', () => {
    expect(flat({ status: 'suspended', readableAsleep: true, canRestart: false })[0]).toBe(
      'open:read,wake,copyLink,copyWorkspaceLink'
    )
  })

  it('a teammate who cannot manage it only opens and copies links', () => {
    expect(flat({ canManage: false })).toEqual(['open:open,copyLink,copyWorkspaceLink'])
  })
})
