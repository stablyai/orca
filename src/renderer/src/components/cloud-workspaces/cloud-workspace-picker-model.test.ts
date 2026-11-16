import { describe, expect, it } from 'vitest'
import {
  initialPickerControls,
  pickerListQuery,
  pickerRows,
  pickerShowsArchived
} from './cloud-workspace-picker-model'
import { DIRECTORY, workspace } from './cloud-workspaces.test-fixture'

const NONE = new Set<string>()
const controls = initialPickerControls()

describe('what the picker reads', () => {
  it('Open: your own workspaces, archived only behind the switch', () => {
    expect(controls).toEqual({ archived: false, search: '' })
    expect(pickerListQuery({ kind: 'open' }, controls)).toEqual({
      scope: 'mine',
      archived: 'exclude'
    })
    expect(pickerListQuery({ kind: 'open' }, { ...controls, archived: true })).toEqual({
      scope: 'mine',
      archived: 'only'
    })
  })

  it('a focused picker reads a fixed list of your own', () => {
    expect(pickerListQuery({ kind: 'running' }, controls)).toEqual({
      scope: 'mine',
      archived: 'exclude'
    })
    expect(pickerListQuery({ kind: 'team-cleanup' }, controls)).toEqual({
      scope: 'mine',
      archived: 'include'
    })
    expect(pickerShowsArchived({ kind: 'open' })).toBe(true)
    expect(pickerShowsArchived({ kind: 'running' })).toBe(false)
    expect(pickerShowsArchived({ kind: 'team-cleanup' })).toBe(false)
  })
})

describe('what the picker lists', () => {
  const mine = workspace({ title: 'Mine here', lastActivityAt: 3 })
  // Handed to Grace (an admin's list still shows it): matched by its owner's name.
  const graces = workspace({
    title: 'Grace’s one',
    ownerUserId: 'user_grace',
    createdBy: 'user_grace',
    lastActivityAt: 5
  })
  const elsewhere = workspace({
    title: 'Started on my laptop',
    status: 'suspended',
    lastActivityAt: 1
  })

  it('Open leaves out what the sidebar already shows, and counts it', () => {
    const { rows, hiddenInSidebar } = pickerRows({
      workspaces: [mine, graces, elsewhere],
      focus: { kind: 'open' },
      inSidebar: new Set([mine.id]),
      search: '',
      directory: DIRECTORY
    })
    // Most recently active first.
    expect(rows.map((w) => w.title)).toEqual(['Grace’s one', 'Started on my laptop'])
    expect(hiddenInSidebar).toBe(1)
  })

  it('the running limit lists your running ones, sidebar ones too', () => {
    const { rows, hiddenInSidebar } = pickerRows({
      workspaces: [mine, elsewhere],
      focus: { kind: 'running' },
      inSidebar: new Set([mine.id]),
      search: '',
      directory: DIRECTORY
    })
    expect(rows).toEqual([mine])
    expect(hiddenInSidebar).toBe(0)
  })

  it('search matches title, repository, owner name and W-number', () => {
    const rows = (search: string): (string | null)[] =>
      pickerRows({
        workspaces: [mine, graces],
        focus: { kind: 'open' },
        inSidebar: NONE,
        search,
        directory: DIRECTORY
      }).rows.map((w) => w.title)
    expect(rows('grace hopper')).toEqual(['Grace’s one'])
    expect(rows('acme/payments')).toHaveLength(2)
    expect(rows(`W-${mine.number}`)).toEqual(['Mine here'])
    expect(rows('nothing like this')).toEqual([])
  })

  it('team cleanup: every team workspace for an owner or admin (scope=all), your own otherwise', () => {
    const controls = { archived: false, search: '' }
    expect(pickerListQuery({ kind: 'team-cleanup' }, controls, true).scope).toBe('all')
    expect(pickerListQuery({ kind: 'team-cleanup' }, controls).scope).toBe('mine')
  })
})
