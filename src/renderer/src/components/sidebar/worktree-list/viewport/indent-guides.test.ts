import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RenderRow } from '../listing/render-row'
import { makeRepo, makeWorktree } from '../listing/worktree-list-lineage-card-test-fixtures'
import { getIndentGuideAncestors, getIndentGuideSegments } from './indent-guides'

const group = (key: string, depth: number): RenderRow => {
  const projectGroup: ProjectGroup = {
    id: key,
    name: key,
    parentPath: null,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  return {
    type: 'header',
    key,
    count: 1,
    icon: { kind: 'project' },
    projectGroup,
    projectGroupDepth: depth
  }
}
const project = (key: string, depth: number): RenderRow => {
  const repo: Repo = {
    id: key,
    path: `/src/${key}`,
    displayName: key,
    badgeColor: '#999999',
    addedAt: 1
  }
  return {
    type: 'header',
    key,
    count: 1,
    icon: { kind: 'project' },
    repo,
    projectGroupDepth: depth
  }
}
const card = (key: string): RenderRow => ({
  type: 'item',
  rowKey: key,
  sectionKey: 'section',
  worktree: makeWorktree({ id: key, displayName: key, branch: key, sortOrder: 0, instanceId: key }),
  repo: makeRepo(),
  depth: 0,
  groupDepth: 0,
  isLastLineageChild: false,
  lineageChildCount: 0
})
const pending = (key: string): RenderRow => ({
  type: 'pending-creation',
  key,
  creationId: key,
  repo: undefined
})

// work/            group, depth 0
//   folder-card    folder workspace of the group
//   audio/         group, depth 1
//     asr          project, depth 2
//       asr-card
//   ana            project, depth 1
//     ana-card
// solo             ungrouped project
//   solo-card
const rows = [
  group('work', 0),
  card('folder-card'),
  group('audio', 1),
  project('asr', 2),
  card('asr-card'),
  project('ana', 1),
  card('ana-card'),
  project('solo', 0),
  card('solo-card')
]

const labels = (ancestors: ReturnType<typeof getIndentGuideAncestors>): string[][] =>
  ancestors.map((row) => row.map(({ key, level }) => `${key}@${level}`))

const spans = (segments: ReturnType<typeof getIndentGuideSegments>): [string, number, number][] =>
  segments
    .map(({ key, top, bottom }): [string, number, number] => [key, top, bottom])
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))

const measured = (from: number, to: number): { index: number; start: number; end: number }[] =>
  Array.from({ length: to - from + 1 }, (_, offset) => ({
    index: from + offset,
    start: (from + offset) * 10,
    end: (from + offset + 1) * 10
  }))

describe('getIndentGuideAncestors', () => {
  it('lists the headers each row sits under, outermost first', () => {
    expect(labels(getIndentGuideAncestors(rows, 'repo'))).toEqual([
      [],
      [':work@0'],
      [':work@0'],
      [':work@0', ':audio@1'],
      [':work@0', ':audio@1', ':asr@2'],
      [':work@0'],
      [':work@0', ':ana@1'],
      [],
      [':solo@0']
    ])
  })

  it('keeps each guide at its header depth when a parent header is not shown', () => {
    const orphanRows = [group('audio', 1), project('asr', 2), card('asr-card')]
    expect(labels(getIndentGuideAncestors(orphanRows, 'repo'))).toEqual([
      [],
      [':audio@1'],
      [':audio@1', ':asr@2']
    ])
    const segments = getIndentGuideSegments(
      getIndentGuideAncestors(orphanRows, 'repo'),
      measured(0, 2),
      new Set()
    )
    expect(segments.map(({ key, level }) => `${key}@${level}`).sort()).toEqual([
      ':asr@2',
      ':audio@1'
    ])
  })

  it('leaves notices without guides', () => {
    expect(getIndentGuideAncestors([project('api', 0), pending('new')], 'repo')).toEqual([[], []])
  })

  it('draws no guides outside project grouping', () => {
    expect(getIndentGuideAncestors(rows, 'workspace-status').flat()).toEqual([])
  })
})

describe('getIndentGuideSegments', () => {
  const ancestors = getIndentGuideAncestors(rows, 'repo')

  it('runs one guide per header, from below it to its last row', () => {
    const segments = getIndentGuideSegments(ancestors, measured(0, 8), new Set())
    expect(spans(segments)).toEqual([
      [':work', 10, 70],
      [':audio', 30, 50],
      [':asr', 40, 50],
      [':ana', 60, 70],
      [':solo', 80, 90]
    ])
  })

  it('marks the guides above the active row', () => {
    const active = new Set(ancestors[4].map((ancestor) => ancestor.key))
    const segments = getIndentGuideSegments(ancestors, measured(0, 8), active)
    expect(
      segments
        .filter((segment) => segment.active)
        .map((segment) => segment.key)
        .sort()
    ).toEqual([':asr', ':audio', ':work'])
  })

  it('never bridges rows that are not measured', () => {
    const segments = getIndentGuideSegments(
      ancestors,
      [...measured(1, 2), ...measured(5, 6)],
      new Set()
    )
    expect(spans(segments)).toEqual([
      [':work', 10, 30],
      [':work', 50, 70],
      [':ana', 60, 70]
    ])
  })
})
