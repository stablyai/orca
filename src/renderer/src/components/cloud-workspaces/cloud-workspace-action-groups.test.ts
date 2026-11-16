import { describe, expect, it } from 'vitest'
import {
  cloudWorkspaceActionGroups,
  type CloudWorkspaceActionInput
} from './cloud-workspace-action-groups'

const base: CloudWorkspaceActionInput = {
  surface: 'list',
  status: 'running',
  archivedAt: null,
  canOpen: true,
  canManage: true,
  readableAsleep: false,
  canRestart: true,
  hasMembers: true
}

const flat = (input: Partial<CloudWorkspaceActionInput>) =>
  cloudWorkspaceActionGroups({ ...base, ...input }).map((g) => `${g.id}:${g.actions.join(',')}`)

describe('one action list for every surface (JA-14)', () => {
  it('the list: Open, Owner, Lifecycle, Danger in that order, with Restart', () => {
    expect(flat({})).toEqual([
      'open:open',
      'owner:reassignOwner',
      'lifecycle:restart,sleep,archive',
      'danger:delete'
    ])
  })

  it('the sidebar gets the same Lifecycle actions, minus list-only items', () => {
    expect(flat({ surface: 'sidebar' })).toEqual([
      'lifecycle:restart,sleep,archive',
      'danger:delete'
    ])
  })

  it('archived: Unarchive, no Restart or Sleep', () => {
    expect(flat({ archivedAt: 1, status: 'suspended' })).toContain('lifecycle:unarchive')
  })

  it('asleep in the list reads the saved copy, and Wake is its own action', () => {
    expect(flat({ status: 'suspended', readableAsleep: true, canRestart: false })[0]).toBe(
      'open:read,wake'
    )
  })

  it('someone who cannot manage it only opens it', () => {
    expect(flat({ canManage: false })).toEqual(['open:open'])
  })

  it('offers no sharing actions', () => {
    const actions: string[] = cloudWorkspaceActionGroups(base).flatMap((g) => g.actions)
    expect(actions).not.toContain('share')
    expect(actions).not.toContain('makePrivate')
    expect(actions).not.toContain('copyLink')
  })
})
