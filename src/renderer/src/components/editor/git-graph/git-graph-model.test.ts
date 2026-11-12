import { expect, it } from 'vitest'
import { GitGraphModel } from './git-graph-model'
import type {
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../shared/git/history/git-history-types'

const item = (id: string, parentIds: string[] = []): GitHistoryItem => ({
  id,
  parentIds,
  subject: id,
  message: id
})
const page = (items: GitHistoryItem[]): GitHistoryResult => ({
  items,
  hasMore: false,
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  limit: 50
})
const currentRef = { id: 'refs/heads/main', name: 'main', revision: 'M' }

it('recolors a late side parent and all later rotating colors without changing published rows', () => {
  const model = new GitGraphModel()
  const merge = item('M', ['A', 'B'])
  const later = item('X', ['Y'])
  const first = { ...page([merge, later]), currentRef }
  model.update(first)
  const published = model.rows
  const expected = [
    { id: 'A', color: 'git-graph-lane-1' },
    { id: 'B', color: 'git-graph-lane-2' }
  ]
  expect(published[0]?.outputSwimlanes).toEqual(expected)
  expect(published[1]?.outputSwimlanes).toEqual([
    ...expected,
    { id: 'Y', color: 'git-graph-lane-3' }
  ])
  const parent = { ...item('B'), references: [currentRef] }
  model.update({ ...first, items: [merge, later, parent] })
  expect(model.rows[0]?.outputSwimlanes).toEqual([
    { id: 'A', color: 'git-graph-lane-1' },
    { id: 'B', color: 'git-graph-ref' }
  ])
  expect(model.rows[1]?.outputSwimlanes).toEqual([
    { id: 'A', color: 'git-graph-lane-1' },
    { id: 'B', color: 'git-graph-ref' },
    { id: 'Y', color: 'git-graph-lane-2' }
  ])
  expect(published[0]?.outputSwimlanes).toEqual(expected)
  expect(published[1]?.outputSwimlanes).toEqual([
    ...expected,
    { id: 'Y', color: 'git-graph-lane-3' }
  ])
  model.update(first)
  model.update({ ...first, items: [merge, later, item('C')] })
  expect(model.rows[0]?.outputSwimlanes).toEqual(expected)
  expect(model.rows[1]?.outputSwimlanes).toEqual([
    ...expected,
    { id: 'Y', color: 'git-graph-lane-3' }
  ])
})

it('resolves same-batch parents first-wins, keeps roots separate and updates raw details and HEAD', () => {
  const model = new GitGraphModel()
  const merge = item('M', ['A', 'B'])
  const parent = { ...item('B'), references: [currentRef] }
  const lead = item('lead')
  model.update({ ...page([lead]), currentRef })
  model.update({
    ...page([lead, merge, parent, item('B'), item('A', ['C']), item('C')]),
    currentRef: { ...currentRef }
  })
  expect(model.rows[1]?.outputSwimlanes).toEqual([
    { id: 'A', color: 'git-graph-lane-1' },
    { id: 'B', color: 'git-graph-ref' }
  ])
  expect(model.rows[2]?.outputSwimlanes).toEqual([{ id: 'A', color: 'git-graph-lane-1' }])
  expect(model.rows.at(-1)?.outputSwimlanes).toEqual([])
  expect(model.find('B')?.item).toEqual({
    id: 'B',
    subject: 'B',
    message: 'B',
    parentIds: [],
    references: [currentRef]
  })
  expect(model.find('B')?.index).toBe(2)
  const refreshed = { ...parent, subject: 'Updated', message: 'New body' }
  model.update({ ...page([merge, refreshed]), currentRef: { ...currentRef, revision: 'B' } })
  expect(model.rows.map((row) => row.kind)).toEqual(['node', 'HEAD'])
  expect(model.find('B')?.item.subject).toBe('Updated')
  expect(model.find('B')?.item.references?.[0]?.color).toBeUndefined()
  model.update(undefined)
  expect(model.rows).toEqual([])
  expect(model.find('B')).toBeUndefined()
  model.update(page([item('fresh')]))
  model.update(page([]))
  expect(model.rows).toEqual([])
  expect(model.find('fresh')).toBeUndefined()
})
