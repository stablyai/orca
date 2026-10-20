import { describe, expect, it } from 'vitest'
import type { PluginTaskFilter } from '../../../../../shared/plugins/plugin-task-source'
import { reconcileFilterSelection, selectedFilterValue } from './plugin-task-filter-selection'

const status: PluginTaskFilter = {
  id: 'status',
  label: 'Status',
  options: [
    { value: '', label: 'All' },
    { value: 'open', label: 'Open' }
  ],
  defaultValue: 'open'
}
const owner: PluginTaskFilter = {
  id: 'owner',
  label: 'Owner',
  options: [{ value: 'me', label: 'Me' }]
}

describe('selectedFilterValue', () => {
  it('keeps an offered value, including the empty "all" option', () => {
    expect(selectedFilterValue(status, '')).toBe('')
    expect(selectedFilterValue(status, 'open')).toBe('open')
  })

  it('falls back to the default, then the first option', () => {
    expect(selectedFilterValue(status, 'archived')).toBe('open')
    expect(selectedFilterValue(owner, undefined)).toBe('me')
  })
})

describe('reconcileFilterSelection', () => {
  it('returns the same object when every selection is still offered', () => {
    const selection = { status: '', owner: 'me' }
    expect(reconcileFilterSelection(selection, [status, owner])).toBe(selection)
  })

  it('drops values the source no longer offers and filters it no longer declares', () => {
    expect(
      reconcileFilterSelection({ status: 'archived', owner: 'me', team: 'core' }, [status, owner])
    ).toEqual({ owner: 'me' })
  })

  it('drops everything when the source offers no filters', () => {
    expect(reconcileFilterSelection({ status: 'open' }, [])).toEqual({})
  })
})
