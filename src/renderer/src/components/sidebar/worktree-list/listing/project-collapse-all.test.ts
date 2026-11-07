import { expect, it } from 'vitest'
import {
  areAllProjectsCollapsed,
  getRenderedProjectCollapseKeys,
  setAllProjectsCollapsed
} from './project-collapse-all'

it('includes pinned and empty project headers using their collapse identities', () => {
  expect(
    getRenderedProjectCollapseKeys([
      { type: 'header', key: 'repo:imports', count: 0, icon: { kind: 'project' } },
      { type: 'header', key: 'repo:inbox', count: 0, icon: { kind: 'project' } },
      { type: 'header', key: 'repo:pending', count: 0, icon: { kind: 'project' } },
      {
        type: 'header',
        key: 'project:one:remote',
        collapseKey: 'project:one',
        count: 2,
        icon: { kind: 'project' }
      },
      {
        type: 'header',
        key: 'project:one:local',
        collapseKey: 'project:one',
        count: 1,
        icon: { kind: 'project' }
      },
      { type: 'header', key: 'pinned', count: 1, icon: { kind: 'pinned' } }
    ])
  ).toEqual(['repo:imports', 'repo:inbox', 'repo:pending', 'project:one', 'pinned'])
})

it('collapses and expands pinned with projects while preserving unrelated sections', () => {
  const keys = getRenderedProjectCollapseKeys([
    { type: 'header', key: 'project:one', count: 1, icon: { kind: 'project' } },
    { type: 'header', key: 'pinned', count: 1, icon: { kind: 'pinned' } }
  ])
  const initial = new Set(['project:one', 'lineage:child', 'status:done'])
  expect(areAllProjectsCollapsed(keys, initial)).toBe(false)
  const collapsed = setAllProjectsCollapsed(initial, keys, true)
  expect(collapsed).toEqual(new Set(['project:one', 'lineage:child', 'status:done', 'pinned']))
  expect(areAllProjectsCollapsed(keys, collapsed)).toBe(true)
  const expanded = setAllProjectsCollapsed(new Set([...collapsed, 'project:hidden']), keys, false)
  expect(expanded).toEqual(new Set(['lineage:child', 'status:done']))
})
