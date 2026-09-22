import { describe, expect, it } from 'vitest'
import {
  haveSamePluginTaskSourceFacetSelections,
  normalizePluginTaskSourceSelections,
  pluginTaskSourceSelectionKey
} from './plugin-task-source-selection-persistence'

describe('pluginTaskSourceSelectionKey', () => {
  it('keeps two sources of the same plugin apart', () => {
    expect(
      pluginTaskSourceSelectionKey({ pluginKey: 'orca-samples.issues', sourceId: 'boards' })
    ).not.toBe(
      pluginTaskSourceSelectionKey({ pluginKey: 'orca-samples.issues', sourceId: 'epics' })
    )
  })
})

describe('normalizePluginTaskSourceSelections', () => {
  it('reads a missing key as nothing saved for any source', () => {
    expect(normalizePluginTaskSourceSelections(undefined)).toEqual({})
  })

  it('keeps an entry whose facets are all cleared, so it still outranks a declared default', () => {
    expect(
      normalizePluginTaskSourceSelections({
        'orca-samples.issues:boards': { facetSelections: {}, scopeIds: [] }
      })
    ).toEqual({ 'orca-samples.issues:boards': { facetSelections: {}, scopeIds: [] } })
  })

  it('drops a facet whose saved options are all unusable rather than keeping an empty array', () => {
    expect(
      normalizePluginTaskSourceSelections({
        'orca-samples.issues:boards': {
          facetSelections: { owner: ['mine'], sprint: [42, ''] },
          scopeIds: ['proj-1', 'proj-1']
        }
      })
    ).toEqual({
      'orca-samples.issues:boards': {
        facetSelections: { owner: ['mine'] },
        scopeIds: ['proj-1']
      }
    })
  })

  it('refuses a selection wider than the query contract accepts', () => {
    const facetSelections: Record<string, string[]> = {}
    for (let index = 0; index < 12; index += 1) {
      facetSelections[`facet-${index}`] = ['mine']
    }

    const normalized = normalizePluginTaskSourceSelections({
      'orca-samples.issues:boards': {
        facetSelections,
        scopeIds: Array.from({ length: 90 }, (_unused, index) => `proj-${index}`)
      }
    })['orca-samples.issues:boards']

    expect(Object.keys(normalized?.facetSelections ?? {})).toHaveLength(8)
    expect(normalized?.scopeIds).toHaveLength(64)
  })

  it('discards an entry that is not a record', () => {
    expect(normalizePluginTaskSourceSelections({ 'orca-samples.issues:boards': 'boards' })).toEqual(
      {}
    )
  })
})

describe('haveSamePluginTaskSourceFacetSelections', () => {
  it('reads two freshly built copies of the same narrowing as unchanged', () => {
    expect(haveSamePluginTaskSourceFacetSelections({ owner: ['mine'] }, { owner: ['mine'] })).toBe(
      true
    )
  })

  it('reads a cleared facet as changed', () => {
    expect(haveSamePluginTaskSourceFacetSelections({ owner: ['mine'] }, {})).toBe(false)
  })

  it('reads a swapped option as changed', () => {
    expect(
      haveSamePluginTaskSourceFacetSelections({ owner: ['mine'] }, { owner: ['nobody'] })
    ).toBe(false)
  })
})
