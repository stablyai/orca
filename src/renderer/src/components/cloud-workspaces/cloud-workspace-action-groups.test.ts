import { describe, expect, it, vi } from 'vitest'
const teamSharing = vi.hoisted(() => ({ on: true }))
vi.mock('@/lib/orca-cloud/cloud-team-sharing-flag', () => ({
  CLOUD_SHARE_LINK_ACTION_ID: 'cloudWorkspace.copyLink',
  cloudTeamSharingEnabled: () => teamSharing.on,
  useCloudTeamSharingEnabled: () => teamSharing.on
}))
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

describe('one action list for every surface', () => {
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

  it('no Share with team or Make private while sharing is held', () => {
    teamSharing.on = false
    try {
      for (const visibility of ['private', 'team'] as const) {
        const actions = cloudWorkspaceActionGroups({ ...base, visibility }).flatMap(
          (g) => g.actions
        )
        expect(actions).not.toContain('share')
        expect(actions).not.toContain('makePrivate')
        expect(actions).toContain('archive')
      }
    } finally {
      teamSharing.on = true
    }
  })
})
