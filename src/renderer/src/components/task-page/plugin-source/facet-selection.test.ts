import { describe, expect, it } from 'vitest'

import type { PluginTaskFacet } from '../../../../../shared/plugins/plugin-task-source-contract'
import {
  clearPluginTaskFacet,
  describePluginTaskFacetSelection,
  filterPluginTaskFacetOptions,
  togglePluginTaskFacetOption
} from './facet-selection'

const STATE: PluginTaskFacet = { id: 'state', label: 'State', kind: 'multi', dynamic: true }
const SPRINT: PluginTaskFacet = { id: 'sprint', label: 'Sprint', kind: 'single', dynamic: true }

const STATE_OPTIONS = [
  { id: 'Active', label: 'Active' },
  { id: 'New', label: 'New' }
]

describe('contributed task source facet selection', () => {
  it('accumulates options within a multi facet', () => {
    const once = togglePluginTaskFacetOption({}, STATE, 'Active')
    expect(togglePluginTaskFacetOption(once, STATE, 'New')).toEqual({
      state: ['Active', 'New']
    })
  })

  it('replaces the selection of a single facet rather than accumulating', () => {
    const once = togglePluginTaskFacetOption({}, SPRINT, 'Sprint 1')
    expect(togglePluginTaskFacetOption(once, SPRINT, 'Sprint 2')).toEqual({
      sprint: ['Sprint 2']
    })
  })

  it('leaves the other facets alone, so two facets compose', () => {
    const state = togglePluginTaskFacetOption({}, STATE, 'Active')
    expect(togglePluginTaskFacetOption(state, SPRINT, 'Sprint 1')).toEqual({
      state: ['Active'],
      sprint: ['Sprint 1']
    })
  })

  it('drops a facet whose last option is deselected rather than sending an empty array', () => {
    const selections = { state: ['Active'], sprint: ['Sprint 1'] }

    expect(togglePluginTaskFacetOption(selections, STATE, 'Active')).toEqual({
      sprint: ['Sprint 1']
    })
  })

  it('drops the key of an explicitly cleared facet rather than sending an empty array', () => {
    const cleared = clearPluginTaskFacet(
      { state: ['Active', 'New'], sprint: ['Sprint 1'] },
      'state'
    )

    expect(cleared).toEqual({ sprint: ['Sprint 1'] })
    expect('state' in cleared).toBe(false)
  })

  it('names the facet alone while nothing is selected', () => {
    expect(describePluginTaskFacetSelection(STATE, STATE_OPTIONS, [])).toBe('State')
  })

  it('names the one chosen option beside the facet', () => {
    expect(describePluginTaskFacetSelection(STATE, STATE_OPTIONS, ['Active'])).toBe('State: Active')
  })

  it('counts a selection spanning several options', () => {
    expect(describePluginTaskFacetSelection(STATE, STATE_OPTIONS, ['Active', 'New'])).toBe(
      'State: 2 selected'
    )
  })

  it('counts rather than shows an id whose option the current scope does not offer', () => {
    expect(describePluginTaskFacetSelection(STATE, STATE_OPTIONS, ['Removed'])).toBe(
      'State: 1 selected'
    )
  })

  it('matches options on their label, never on the provider-native id', () => {
    const options = [
      { id: 'a4d1', label: 'Active' },
      { id: 'n0b2', label: 'New' }
    ]

    expect(filterPluginTaskFacetOptions(options, 'act')).toEqual([options[0]])
    expect(filterPluginTaskFacetOptions(options, 'a4d1')).toEqual([])
  })
})
