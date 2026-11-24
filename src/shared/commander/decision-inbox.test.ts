import { expect, it } from 'vitest'
import { groupPendingDecisions } from './decision-inbox'

it('keeps each prompt tied to its source, without merging unknown questions or counting completed requests', () => {
  const request = (source: string, state: string, summary?: string) => ({
    id: source,
    state,
    summary,
    since: 1,
    value: source
  })
  const groups = groupPendingDecisions([
    request('host-b/repo-a', 'waiting', 'Choose release target'),
    request('host-a/repo-b', 'blocked', 'Choose release target'),
    request('host-a/repo-c', 'done', 'Choose release target'),
    request('host-a/repo-d', 'blocked'),
    request('host-b/repo-d', 'blocked'),
    request('host-a/repo-e', 'waiting')
  ])
  expect(groups.map((group) => group.requests.map((row) => row.value))).toEqual([
    ['host-a/repo-b', 'host-b/repo-a'],
    ['host-a/repo-d'],
    ['host-b/repo-d']
  ])
})
