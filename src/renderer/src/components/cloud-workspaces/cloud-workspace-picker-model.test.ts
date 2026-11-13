import { describe, expect, it } from 'vitest'
import {
  initialPickerControls,
  pickerListQuery,
  pickerRows,
  pickerShowsArchived,
  pickerShowsScope
} from './cloud-workspace-picker-model'
import { DIRECTORY, workspace } from './cloud-workspaces.test-fixture'

const NONE = new Set<string>()
const controls = initialPickerControls(true)

describe('what the picker reads', () => {
  it('Open: the team list on a team, yours without one, archived only behind the switch', () => {
    expect(controls).toEqual({ scope: 'team', archived: false, search: '' })
    expect(pickerListQuery({ kind: 'open' }, controls, true)).toEqual({
      scope: 'team',
      archived: 'exclude'
    })
    expect(pickerListQuery({ kind: 'open' }, { ...controls, archived: true }, true)).toEqual({
      scope: 'team',
      archived: 'only'
    })
    expect(pickerListQuery({ kind: 'open' }, initialPickerControls(false), false)).toEqual({
      scope: 'mine',
      archived: 'exclude'
    })
  })

  it('a focused picker reads a fixed list and offers no scope switch', () => {
    expect(pickerListQuery({ kind: 'running' }, controls, true)).toEqual({
      scope: 'mine',
      archived: 'exclude'
    })
    expect(pickerListQuery({ kind: 'team-cleanup' }, controls, true)).toEqual({
      scope: 'team',
      archived: 'include'
    })
    expect(pickerShowsScope({ kind: 'open' }, true)).toBe(true)
    expect(pickerShowsScope({ kind: 'open' }, false)).toBe(false)
    expect(pickerShowsScope({ kind: 'teammate', userId: 'user_grace' }, true)).toBe(false)
    expect(pickerShowsArchived({ kind: 'running' })).toBe(false)
    expect(pickerShowsArchived({ kind: 'team-cleanup' })).toBe(false)
  })
})

describe('what the picker lists', () => {
  const mine = workspace({ title: 'Mine here', lastActivityAt: 3 })
  const shared = workspace({
    title: 'Grace’s shared one',
    ownerUserId: 'user_grace',
    createdBy: 'user_grace',
    access: 'can_open',
    lastActivityAt: 5
  })
  const elsewhere = workspace({
    title: 'Started on my laptop',
    status: 'suspended',
    lastActivityAt: 1
  })

  it('Open leaves out what the sidebar already shows, and counts it', () => {
    const { rows, hiddenInSidebar } = pickerRows({
      workspaces: [mine, shared, elsewhere],
      focus: { kind: 'open' },
      inSidebar: new Set([mine.id]),
      search: '',
      directory: DIRECTORY
    })
    // Most recently active first.
    expect(rows.map((w) => w.title)).toEqual(['Grace’s shared one', 'Started on my laptop'])
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

  it('a teammate focus lists only what they own or started', () => {
    const { rows } = pickerRows({
      workspaces: [mine, shared],
      focus: { kind: 'teammate', userId: 'user_grace' },
      inSidebar: NONE,
      search: '',
      directory: DIRECTORY
    })
    expect(rows).toEqual([shared])
  })

  it('search matches title, repository, owner name and W-number', () => {
    const rows = (search: string): (string | null)[] =>
      pickerRows({
        workspaces: [mine, shared],
        focus: { kind: 'open' },
        inSidebar: NONE,
        search,
        directory: DIRECTORY
      }).rows.map((w) => w.title)
    expect(rows('grace hopper')).toEqual(['Grace’s shared one'])
    expect(rows('acme/payments')).toHaveLength(2)
    expect(rows(`W-${mine.number}`)).toEqual(['Mine here'])
    expect(rows('nothing like this')).toEqual([])
  })
})
