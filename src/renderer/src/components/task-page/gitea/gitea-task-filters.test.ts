import { describe, expect, it } from 'vitest'
import type { GiteaWorkItem } from '../../../../../shared/gitea-types'
import {
  EMPTY_GITEA_ITEM_FILTERS,
  filterGiteaWorkItems,
  giteaAuthorOptions,
  giteaLabelOptions,
  giteaStateFiltersFor,
  isGiteaStateFilterValidFor
} from './gitea-task-filters'

const item = (number: number, author: string | null, labels: string[]): GiteaWorkItem => ({
  id: `issue:${number}`,
  type: 'issue',
  number,
  title: `Item ${number} crash`,
  state: 'open',
  url: '',
  labels,
  updatedAt: '',
  author,
  repoId: 'r'
})

const items = [item(1, 'sam', ['bug']), item(2, 'lee', ['ui']), item(3, null, [])]

describe('gitea task filters', () => {
  it('offers Open/Closed/All for issues and adds Merged for PRs', () => {
    expect(giteaStateFiltersFor('issues')).toEqual(['opened', 'closed', 'all'])
    expect(giteaStateFiltersFor('prs')).toContain('merged')
    expect(isGiteaStateFilterValidFor('issues', 'merged')).toBe(false)
  })

  it('filters by author, label, and search text', () => {
    const run = (patch: Partial<typeof EMPTY_GITEA_ITEM_FILTERS>) =>
      filterGiteaWorkItems(items, { ...EMPTY_GITEA_ITEM_FILTERS, ...patch }).map((i) => i.number)
    expect(run({})).toEqual([1, 2, 3])
    expect(run({ author: 'lee' })).toEqual([2])
    expect(run({ label: 'bug' })).toEqual([1])
    expect(run({ search: '#3' })).toEqual([3])
    expect(run({ search: 'ITEM 2' })).toEqual([2])
  })

  it('derives option lists from loaded items and repo labels', () => {
    expect(giteaAuthorOptions(items)).toEqual(['lee', 'sam'])
    expect(giteaLabelOptions(items, ['docs', 'bug'])).toEqual(['bug', 'docs', 'ui'])
  })
})
