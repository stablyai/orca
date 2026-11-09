import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RenderRow } from '../listing/render-row'
import { getIndentGuideLevels, getIndentGuideSegments } from './indent-guides'

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
  type: 'pending-creation',
  key,
  creationId: key,
  repo: undefined
})

// work/            group, depth 0
//   audio/         group, depth 1
//     asr          project, depth 2
//       card
//   data-ana       project, depth 1
//     card
// solo             ungrouped project
//   card
const rows = [
  group('work', 0),
  group('audio', 1),
  project('asr', 2),
  card('asr-card'),
  project('data-ana', 1),
  card('ana-card'),
  project('solo', 0),
  card('solo-card')
]

const measured = (from: number, to: number): { index: number; start: number; end: number }[] =>
  Array.from({ length: to - from + 1 }, (_, offset) => ({
    index: from + offset,
    start: (from + offset) * 10,
    end: (from + offset + 1) * 10
  }))

describe('getIndentGuideLevels', () => {
  it('gives each row the depth of the group header that owns it', () => {
    expect(getIndentGuideLevels(rows, 'repo')).toEqual([0, 1, 2, 2, 1, 1, 0, 0])
  })

  it('puts rows right under a group, such as folder workspaces, one level below it', () => {
    const folderRows = [group('work', 0), card('folder'), project('api', 1), card('api-card')]
    expect(getIndentGuideLevels(folderRows, 'repo')).toEqual([0, 1, 1, 1])
  })

  it('draws no guides outside project grouping', () => {
    expect(getIndentGuideLevels(rows, 'workspace-status')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('getIndentGuideSegments', () => {
  it('runs each group guide from below its header to its last nested row', () => {
    const segments = getIndentGuideSegments(getIndentGuideLevels(rows, 'repo'), measured(0, 7))
    expect(segments).toEqual([
      { level: 1, top: 20, bottom: 40 },
      { level: 0, top: 10, bottom: 60 }
    ])
  })

  it('never bridges rows that are not measured', () => {
    const levels = getIndentGuideLevels(rows, 'repo')
    const segments = getIndentGuideSegments(levels, [...measured(1, 2), ...measured(4, 5)])
    expect(segments).toEqual([
      { level: 0, top: 10, bottom: 30 },
      { level: 1, top: 20, bottom: 30 },
      { level: 0, top: 40, bottom: 60 }
    ])
  })
})
