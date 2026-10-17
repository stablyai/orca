// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  applyProjectViewLayoutOverrides,
  hasProjectViewLayoutOverrides,
  loadProjectViewLayoutOverrides,
  projectFieldPool,
  saveProjectViewLayoutOverrides
} from './project-view-layout-overrides'
import type {
  GitHubProjectField,
  GitHubProjectTable
} from '../../../../shared/github/project-types'

const TITLE: GitHubProjectField = {
  kind: 'field',
  id: 'f_title',
  name: 'Title',
  dataType: 'TITLE'
}
const ASSIGNEES: GitHubProjectField = {
  kind: 'field',
  id: 'f_assignees',
  name: 'Assignees',
  dataType: 'ASSIGNEES'
}
const LABELS: GitHubProjectField = {
  kind: 'field',
  id: 'f_labels',
  name: 'Labels',
  dataType: 'LABELS'
}
const STATUS: GitHubProjectField = {
  kind: 'single-select',
  id: 'f_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [{ id: 'opt_todo', name: 'Todo', color: 'GREEN' }]
}
const SPRINT: GitHubProjectField = {
  kind: 'iteration',
  id: 'f_sprint',
  name: 'Sprint',
  dataType: 'ITERATION',
  iterations: []
}

function table(projectFields?: GitHubProjectField[]): GitHubProjectTable {
  return {
    project: {
      id: 'PVT_1',
      owner: 'o',
      ownerType: 'user',
      number: 1,
      title: 'Project',
      url: 'https://github.com/users/o/projects/1'
    },
    selectedView: {
      id: 'PVTV_1',
      number: 1,
      name: 'Board',
      layout: 'BOARD_LAYOUT',
      filter: '',
      fields: [TITLE, STATUS],
      groupByFields: [],
      sortByFields: [],
      verticalGroupByFields: [STATUS]
    },
    ...(projectFields ? { projectFields } : {}),
    rows: [],
    totalCount: 0,
    parentFieldDropped: false
  }
}

afterEach(() => window.localStorage.clear())

describe('projectFieldPool', () => {
  it('keeps the view order first and appends fields the view hides', () => {
    expect(projectFieldPool(table([SPRINT, STATUS, ASSIGNEES])).map((f) => f.id)).toEqual([
      'f_title',
      'f_status',
      'f_sprint',
      'f_assignees'
    ])
  })

  it('falls back to the view config when an older host omits project fields', () => {
    expect(projectFieldPool(table()).map((f) => f.id)).toEqual(['f_title', 'f_status'])
  })
})

describe('applyProjectViewLayoutOverrides', () => {
  it('returns the same table when nothing is overridden', () => {
    const source = table()
    expect(applyProjectViewLayoutOverrides(source, undefined)).toBe(source)
    expect(applyProjectViewLayoutOverrides(source, { groupFieldId: undefined })).toBe(source)
  })

  it('shows hidden project fields and never drops Title', () => {
    const view = applyProjectViewLayoutOverrides(table([SPRINT, ASSIGNEES]), {
      fieldIds: ['f_assignees', 'f_sprint']
    }).selectedView
    expect(view.fields.map((f) => f.id)).toEqual(['f_title', 'f_sprint', 'f_assignees'])
  })

  it('sets the column field only to single-select or iteration fields', () => {
    const source = table([SPRINT, ASSIGNEES])
    expect(
      applyProjectViewLayoutOverrides(source, { columnFieldId: 'f_sprint' }).selectedView
        .verticalGroupByFields
    ).toEqual([SPRINT])
    expect(
      applyProjectViewLayoutOverrides(source, { columnFieldId: 'f_assignees' }).selectedView
        .verticalGroupByFields
    ).toEqual([STATUS])
  })

  it('groups by a groupable field, turns grouping off with null, and ignores unknown ids', () => {
    const source = table([SPRINT, ASSIGNEES, LABELS])
    const group = (groupFieldId: string | null) =>
      applyProjectViewLayoutOverrides(source, { groupFieldId }).selectedView.groupByFields
    expect(group('f_assignees')).toEqual([ASSIGNEES])
    expect(group('f_labels')).toEqual([])
    expect(group('gone')).toEqual([])
    const grouped = table()
    grouped.selectedView.groupByFields = [STATUS]
    expect(
      applyProjectViewLayoutOverrides(grouped, { groupFieldId: null }).selectedView.groupByFields
    ).toEqual([])
  })

  it('switches the layout without touching the cached table', () => {
    const source = table()
    const applied = applyProjectViewLayoutOverrides(source, {
      layout: 'TABLE_LAYOUT'
    })
    expect(applied.selectedView.layout).toBe('TABLE_LAYOUT')
    expect(source.selectedView.layout).toBe('BOARD_LAYOUT')
  })
})

describe('override persistence', () => {
  it('round-trips per scope and deletes empty overrides', () => {
    saveProjectViewLayoutOverrides('PVT_1:PVTV_1', { groupFieldId: null })
    expect(loadProjectViewLayoutOverrides('PVT_1:PVTV_1')).toEqual({
      groupFieldId: null
    })
    expect(loadProjectViewLayoutOverrides('PVT_1:PVTV_2')).toBeUndefined()
    saveProjectViewLayoutOverrides('PVT_1:PVTV_1', { layout: undefined })
    expect(loadProjectViewLayoutOverrides('PVT_1:PVTV_1')).toBeUndefined()
    expect(hasProjectViewLayoutOverrides({ groupFieldId: null })).toBe(true)
  })

  it('ignores a corrupt stored map', () => {
    window.localStorage.setItem('orca.githubProject.viewLayoutOverrides', '[1,2]')
    expect(loadProjectViewLayoutOverrides('PVT_1:PVTV_1')).toBeUndefined()
  })
})
