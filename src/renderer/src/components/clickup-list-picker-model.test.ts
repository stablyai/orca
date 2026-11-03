import { describe, expect, it } from 'vitest'
import type { ClickUpList } from '../../../shared/clickup-types'
import {
  clickUpSelectedListName,
  filterClickUpPickerSprints,
  groupClickUpPickerLists,
  matchesClickUpPickerQuery,
  resolveClickUpListSelection
} from './clickup-list-picker-model'
import {
  detectClickUpSprints,
  findCurrentClickUpSprint,
  groupClickUpSprintFolders,
  pickDefaultClickUpSprintFolder
} from './clickup-sprints'

const now = new Date('2026-10-15T12:00:00.000Z')

function list(
  id: string,
  name: string,
  folder: { id: string; name: string } | undefined,
  extra: Partial<ClickUpList> = {}
): ClickUpList {
  return { id, workspaceId: '1234567', name, statuses: [], folder, ...extra }
}

function sprint(
  id: string,
  name: string,
  folder: { id: string; name: string },
  start: string,
  due: string,
  taskCount: number
): ClickUpList {
  return list(id, name, folder, {
    startDate: `${start}T00:00:00.000Z`,
    dueDate: `${due}T00:00:00.000Z`,
    taskCount
  })
}

// Shaped like a real team hierarchy (made-up ids and names).
const q3 = { id: '700010378931', name: 'Team Sprints - Q3 2026' }
const weekly = { id: '70002051634', name: 'Team Sprints' }
const dev = { id: '70002465092', name: 'Dev Sprints' }
const qe = { id: '70009725264', name: 'QE Sprint Folder' }
const voc = { id: '70001832819', name: 'Customer Feedback' }
const teamLists: ClickUpList[] = [
  list('700018328197', 'Customer Feedback', voc, { taskCount: 174 }),
  sprint('700021093583', 'Sprint 13 (9/22 - 9/28)', q3, '2026-09-21', '2026-09-28', 10),
  sprint('700021351728', 'Sprint 14 (9/29 - 10/5)', q3, '2026-09-28', '2026-10-05', 3),
  sprint('700021622270', 'Sprint 15 (10/6 - 10/12)', q3, '2026-10-05', '2026-10-12', 4),
  sprint('700021931549', 'Sprint 16 (10/13 - 10/19)', q3, '2026-10-12', '2026-10-19', 66),
  sprint('700022195408', 'Sprint 17 (10/20 - 10/26)', q3, '2026-10-19', '2026-10-26', 0),
  sprint('700021931485', 'Sprint 126 (10/13 - 10/19)', weekly, '2026-10-12', '2026-10-19', 8),
  sprint('700021093560', 'Sprint 61 (10/13 - 10/26)', dev, '2026-10-12', '2026-10-26', 156),
  list('700016851249', 'QE Backlog Tasks', qe, { taskCount: 1 }),
  sprint('700016851170', 'Sprint 1 (6/1 - 6/14)', qe, '2026-05-31', '2026-06-14', 16),
  list('700000000001', 'Bugs and Requests', undefined, { taskCount: 12 })
]

describe('ClickUp sprint folders', () => {
  it('defaults to its newest active Folder, not the one with the most tasks', () => {
    const folders = groupClickUpSprintFolders(detectClickUpSprints(teamLists, now))
    expect(folders.map((folder) => folder.name)).toEqual([
      'QE Sprint Folder',
      'Team Sprints - Q3 2026',
      'Team Sprints',
      'Dev Sprints'
    ])
    const picked = pickDefaultClickUpSprintFolder(folders, now)
    expect(picked?.name).toBe('Team Sprints - Q3 2026')
    expect(picked?.sprints.map((item) => item.name)).toEqual([
      'Sprint 13 (9/22 - 9/28)',
      'Sprint 14 (9/29 - 10/5)',
      'Sprint 15 (10/6 - 10/12)',
      'Sprint 16 (10/13 - 10/19)',
      'Sprint 17 (10/20 - 10/26)'
    ])
    const current = findCurrentClickUpSprint(picked?.sprints ?? [], now)
    expect(current).toMatchObject({ name: 'Sprint 16 (10/13 - 10/19)', taskCount: 66 })
  })

  it('falls back to the newest Folder when no Sprint covers today', () => {
    const folders = groupClickUpSprintFolders(
      detectClickUpSprints(teamLists, new Date('2027-03-01T00:00:00.000Z'))
    )
    expect(pickDefaultClickUpSprintFolder(folders, new Date('2027-03-01'))?.id).toBe(q3.id)
    expect(pickDefaultClickUpSprintFolder([], now)).toBeNull()
  })
})

describe('ClickUp Sprint / List picker model', () => {
  it('groups non-sprint Lists by Folder with Folderless Lists last', () => {
    expect(
      groupClickUpPickerLists(teamLists, '').map((group) => [
        group.folderName,
        group.lists.map((item) => item.name)
      ])
    ).toEqual([
      ['Customer Feedback', ['Customer Feedback']],
      ['QE Sprint Folder', ['QE Backlog Tasks']],
      [null, ['Bugs and Requests']]
    ])
  })

  it('filters Lists by List or Folder name and Sprints by name as you type', () => {
    expect(groupClickUpPickerLists(teamLists, 'customer feed')[0]?.lists[0]?.id).toBe(
      '700018328197'
    )
    expect(groupClickUpPickerLists(teamLists, 'qe sprint')[0]?.lists.map((l) => l.name)).toEqual([
      'QE Backlog Tasks'
    ])
    expect(groupClickUpPickerLists(teamLists, 'nothing here')).toEqual([])
    const folder = pickDefaultClickUpSprintFolder(
      groupClickUpSprintFolders(detectClickUpSprints(teamLists, now)),
      now
    )
    expect(filterClickUpPickerSprints(folder?.sprints ?? [], '16').map((s) => s.listId)).toEqual([
      '700021931549'
    ])
    expect(matchesClickUpPickerQuery('Customer Feedback', '  ')).toBe(true)
  })

  it('resolves the selection to one list_ids[] entry', () => {
    const current = findCurrentClickUpSprint(detectClickUpSprints(teamLists, now), now)
    expect(resolveClickUpListSelection('all', teamLists, current)).toBeNull()
    expect(resolveClickUpListSelection('current', teamLists, null)).toBeNull()
    expect(resolveClickUpListSelection({ listId: '700018328197' }, teamLists, current)).toBe(
      '700018328197'
    )
    // A saved List that left the Space must not leave the page empty.
    expect(resolveClickUpListSelection({ listId: 'gone' }, teamLists, current)).toBeNull()
    expect(clickUpSelectedListName({ listId: '700018328197' }, teamLists)).toBe('Customer Feedback')
    expect(clickUpSelectedListName('current', teamLists)).toBeNull()
  })
})
