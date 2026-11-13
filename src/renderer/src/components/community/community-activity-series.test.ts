import { afterEach, expect, test, vi } from 'vitest'
import type { CommunityActivity } from '../../../../shared/community-operations'
import {
  communityActivityGroups,
  communityActivityWeeks,
  communityOutcomeCounts
} from './community-activity-series'

const row = (
  changes: Partial<CommunityActivity['rows'][number]> = {}
): CommunityActivity['rows'][number] => ({
  number: 1,
  author: 'contributor',
  authorAssociation: 'CONTRIBUTOR',
  memberReviewed: null,
  memberApproved: null,
  createdAt: '2026-11-04T12:00:00Z',
  merged: false,
  closed: false,
  reviewed: null,
  approved: null,
  maintainerReviewed: null,
  maintainerApproved: null,
  ...changes
})
const capture = (rows: CommunityActivity['rows']): CommunityActivity => ({
  capturedAt: '2026-11-05T12:00:00Z',
  since: '2026-11-02T12:00:00Z',
  cutoff: '2026-11-02T12:00:00Z',
  complete: true,
  rows,
  maintainers: null,
  roleError: null
})
afterEach(() => vi.unstubAllEnvs())

test('keeps automated and unclassified authors outside both human comparison groups', () => {
  const data = capture([
    row(),
    row({ author: 'admin', authorAssociation: 'OWNER' }),
    row({ author: 'robot', authorType: 'Bot' }),
    row({ author: 'Deleted account' })
  ])
  expect(
    communityActivityGroups(data, 'affiliation').map((group) => [
      group.id,
      group.rows.map((entry) => entry.author)
    ])
  ).toEqual([
    ['community', ['contributor']],
    ['team', ['admin']],
    ['automation', ['robot']],
    ['unknown', ['Deleted account']]
  ])
  expect(communityActivityGroups(data, 'roles').map((group) => group.rows.length)).toEqual([
    0, 0, 1, 3
  ])
})

test('unknown approvals do not enter the observed denominator and outcomes stay exclusive', () => {
  const data = capture([
    row({ merged: true, closed: true, memberApproved: true }),
    row({ closed: true, memberApproved: false }),
    row()
  ])
  const week = communityActivityWeeks(data, 'affiliation')[0]
  expect(week.groups[0]).toEqual({ id: 'community', count: 3, known: 2, approved: 1 })
  expect(communityOutcomeCounts(data.rows)).toEqual([1, 1, 1])
})

test('groups submission weeks at the viewer’s local Monday after a daylight-saving change', () => {
  vi.stubEnv('TZ', 'America/New_York')
  const data = capture([
    row({ createdAt: '2026-11-02T04:30:00Z' }),
    row({ createdAt: '2026-11-02T05:30:00Z' })
  ])
  data.since = '2026-11-01T00:00:00Z'
  expect(
    communityActivityWeeks(data, 'affiliation').map((week) => [week.date, week.groups[0].count])
  ).toEqual([
    ['2026-10-26T04:00:00.000Z', 1],
    ['2026-11-02T05:00:00.000Z', 1]
  ])
})
