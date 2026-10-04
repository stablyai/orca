import { describe, expect, it } from 'vitest'
import {
  applySidebarFilterSuggestion,
  getSidebarFilterQuerySuggestions,
  type SidebarFilterSuggestionCatalog
} from './sidebar-filter-query-suggestions'

const catalog: SidebarFilterSuggestionCatalog = {
  hosts: [
    { id: 'local', label: 'This Mac' },
    { id: 'ssh:buildbox', label: 'Build Box' }
  ],
  repos: ['orca', 'site-private', 'orca'],
  branches: ['main', 'fix/relay'],
  statuses: [{ id: 'in-review', label: 'In Review' }]
}

function suggest(query: string, caret = query.length) {
  return getSidebarFilterQuerySuggestions({ query, caret, catalog })
}

describe('getSidebarFilterQuerySuggestions', () => {
  it('offers every qualifier key for an empty field', () => {
    const set = suggest('')
    expect(set?.items.map((item) => item.label)).toContain('host:')
    expect(set).toMatchObject({ start: 0, end: 0 })
  })

  it('narrows qualifier keys by prefix and keeps a leading dash', () => {
    const set = suggest('orca -ho')
    expect(set?.items).toEqual([{ label: 'host:', qualifier: 'host', replacement: '-host:' }])
    expect(set).toMatchObject({ start: 5, end: 8 })
  })

  it('offers host labels once the qualifier has its colon, matching label or id', () => {
    expect(suggest('host:bu')?.items.map((item) => item.label)).toEqual(['Build Box'])
    expect(suggest('host:ssh')?.items.map((item) => item.label)).toEqual(['Build Box'])
  })

  it('quotes values with spaces and keeps earlier comma values', () => {
    const set = suggest('host:local,bu')
    expect(set?.items[0]?.replacement).toBe('host:local,"Build Box" ')
  })

  it('dedupes and sorts project names', () => {
    expect(suggest('repo:')?.items.map((item) => item.label)).toEqual(['orca', 'site-private'])
  })

  it('offers the fixed is: vocabulary', () => {
    expect(suggest('is:sl')?.items.map((item) => item.label)).toEqual(['sleeping'])
  })

  it('returns null for unknown qualifiers, quoted phrases, and keys without values', () => {
    expect(suggest('foo:ba')).toBeNull()
    expect(suggest('"two wo')).toBeNull()
    expect(suggest('pr:12')).toBeNull()
  })

  it('suggests for the token under the caret, not the last token', () => {
    const query = 'bra orca'
    const set = suggest(query, 3)
    expect(set?.items.map((item) => item.label)).toEqual(['branch:'])
    expect(set).toMatchObject({ start: 0, end: 3 })
  })
})

describe('applySidebarFilterSuggestion', () => {
  it('replaces the token range and places the caret after the insertion', () => {
    const set = suggest('orca -ho')!
    const applied = applySidebarFilterSuggestion('orca -ho', set, set.items[0]!)
    expect(applied).toEqual({ query: 'orca -host:', caret: 11 })
  })
})
