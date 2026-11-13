import { describe, expect, it } from 'vitest'
import {
  ANY,
  INITIAL_TEAM_WORKSPACE_FILTERS as ALL,
  teamWorkspaceActions,
  teamWorkspaceFilterOptions,
  teamWorkspaceRows
} from './team-workspaces-model'
import { DIRECTORY, workspace } from '../../cloud-workspaces/cloud-workspaces.test-fixture'

const mine = workspace({ title: 'Checkout retries', lastActivityAt: 3 })
const grace = workspace({
  title: 'Refund webhooks',
  repo: { url: 'https://github.com/acme/web.git', branch: 'refunds' },
  ownerUserId: 'user_grace',
  createdBy: 'user_grace',
  access: 'can_open',
  lastActivityAt: 5
})
const archived = workspace({
  title: 'Old spike',
  ownerUserId: 'user_linus',
  createdBy: 'user_linus',
  access: 'can_open',
  archivedAt: 1,
  status: 'suspended',
  lastActivityAt: 1
})

describe('Settings › Workspaces filters', () => {
  it('offers By for everyone who started one and In for every repository', () => {
    const { people, repos } = teamWorkspaceFilterOptions([mine, grace, archived])
    expect(people).toEqual(['user_ada', 'user_grace', 'user_linus'])
    expect(repos).toEqual([
      'https://github.com/acme/payments.git',
      'https://github.com/acme/web.git'
    ])
  })

  it('lists everything, archived included, most recently active first', () => {
    expect(teamWorkspaceRows([archived, mine, grace], ALL, DIRECTORY).map((w) => w.title)).toEqual([
      'Refund webhooks',
      'Checkout retries',
      'Old spike'
    ])
  })

  it('narrows by person, by repository and by search', () => {
    const titles = (patch: Partial<typeof ALL>) =>
      teamWorkspaceRows([mine, grace, archived], { ...ALL, ...patch }, DIRECTORY).map(
        (w) => w.title
      )
    expect(titles({ by: 'user_grace' })).toEqual(['Refund webhooks'])
    expect(titles({ repo: 'https://github.com/acme/payments.git' })).toEqual([
      'Checkout retries',
      'Old spike'
    ])
    expect(titles({ search: 'linus park' })).toEqual(['Old spike'])
    expect(titles({ search: `W-${grace.number}` })).toEqual(['Refund webhooks'])
    expect(titles({ by: ANY, repo: ANY, search: 'nothing' })).toEqual([])
  })
})

describe('Settings › Workspaces row actions (never one the server would refuse)', () => {
  it('an admin may open, sleep and archive a teammate’s running workspace', () => {
    expect(teamWorkspaceActions(grace, true)).toEqual({ open: true, sleep: true, archive: true })
  })

  it('without admin rights, a teammate’s workspace can only be opened', () => {
    expect(teamWorkspaceActions(grace, false)).toEqual({ open: true, sleep: false, archive: false })
  })

  it('asleep: no Sleep; starting or mid-transition: no Archive', () => {
    expect(teamWorkspaceActions({ ...grace, status: 'suspended' }, true)).toEqual({
      open: true,
      sleep: false,
      archive: true
    })
    expect(teamWorkspaceActions({ ...grace, status: 'creating' }, true).archive).toBe(false)
    expect(teamWorkspaceActions({ ...grace, status: 'suspending' }, true).archive).toBe(false)
  })

  it('archived: nothing to open, sleep or archive', () => {
    expect(teamWorkspaceActions(archived, true)).toEqual({
      open: false,
      sleep: false,
      archive: false
    })
  })

  it('a private one you cannot open is not offered to open', () => {
    expect(teamWorkspaceActions({ ...grace, access: 'none' }, true)).toMatchObject({
      open: false,
      sleep: true
    })
  })
})
