import { expect, it } from 'vitest'
import type {
  GroupHeaderRow,
  PendingCreationRow
} from '../../../../../../shared/sidebar-list/row-types'
import { group, repo } from '../parity/sidebar-list-golden-factories.test-fixture'
import { buildProjectBlockFrames, hasProjectGroupExitGap } from './project-block-frames'

function projectHeader(id: string, depth = 0): GroupHeaderRow {
  return {
    type: 'header',
    key: id,
    icon: { kind: 'project' },
    count: 0,
    repo: repo(id, id),
    projectGroupDepth: depth
  }
}

it('separates a collapsed group label from the ungrouped project below it', () => {
  const label: GroupHeaderRow = {
    type: 'header',
    key: 'group:tools',
    icon: { kind: 'project' },
    count: 1,
    projectGroup: group('tools', 'Tools', { isCollapsed: true }),
    projectGroupDepth: 0
  }
  expect(hasProjectGroupExitGap([label, projectHeader('outside')], 0, null)).toBe(true)
})

it('leaves a gap only after the last project in a nested group', () => {
  const rows = [projectHeader('first', 2), projectHeader('last', 2), projectHeader('outer', 1)]
  expect(buildProjectBlockFrames(rows)).toEqual([
    { position: 'single', depth: 2, exitGap: false },
    { position: 'single', depth: 2, exitGap: true },
    { position: 'single', depth: 1, exitGap: false }
  ])
})

it('keeps pending workspace creations inside their project block', () => {
  const header = projectHeader('tools', 1)
  const pending = (id: string): PendingCreationRow => ({
    type: 'pending-creation',
    key: `pending:${id}`,
    creationId: id,
    repo: header.repo
  })
  expect(buildProjectBlockFrames([header, pending('a'), pending('b')])).toEqual([
    { position: 'start', depth: 1 },
    { position: 'middle', depth: 1 },
    { position: 'end', depth: 1, exitGap: false }
  ])
})
