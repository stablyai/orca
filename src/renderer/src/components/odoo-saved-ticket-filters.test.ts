import { afterEach, describe, expect, it } from 'vitest'

import {
  getDefaultSavedOdooTicketFilter,
  getPinnedSavedOdooTicketFilters,
  isSavedOdooTicketFilterActive,
  MAX_SAVED_FILTERS,
  ODOO_SEEDED_FILTER_PRESETS,
  parseSavedOdooTicketFilters,
  readSavedOdooTicketFilters,
  writeSavedOdooTicketFilters,
  removeSavedOdooTicketFilter,
  reorderSavedOdooTicketFilters,
  seedDefaultSavedOdooTicketFilters,
  setDefaultSavedOdooTicketFilter,
  toggleSavedOdooTicketFilterPin,
  upsertSavedOdooTicketFilter,
  type OdooSavedTicketFilter
} from './odoo-saved-ticket-filters'
import { DEFAULT_ODOO_TICKET_FILTERS } from './odoo-ticket-facets'

const MINE = { ...DEFAULT_ODOO_TICKET_FILTERS, stages: ['Review'], assignee: '5', tag: '9' }

function saved(
  name: string,
  overrides: Partial<OdooSavedTicketFilter> = {}
): OdooSavedTicketFilter {
  return {
    id: name.toLowerCase(),
    name,
    preset: 'assigned',
    filters: DEFAULT_ODOO_TICKET_FILTERS,
    ...overrides
  }
}

describe('parseSavedOdooTicketFilters', () => {
  it('returns an empty list for missing or malformed payloads', () => {
    expect(parseSavedOdooTicketFilters(null)).toEqual([])
    expect(parseSavedOdooTicketFilters('not json')).toEqual([])
    expect(parseSavedOdooTicketFilters('{"a":1}')).toEqual([])
  })

  it('drops entries without a usable name and de-duplicates by normalised name', () => {
    const raw = JSON.stringify([
      { name: 'Dev', preset: 'all', filters: MINE },
      { name: '  dev  ', preset: 'assigned', filters: DEFAULT_ODOO_TICKET_FILTERS },
      { name: '   ' },
      { preset: 'all' }
    ])
    const parsed = parseSavedOdooTicketFilters(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ id: 'dev', name: 'Dev', preset: 'all', filters: MINE })
  })

  it('falls back to safe defaults for unknown presets and priorities', () => {
    const raw = JSON.stringify([
      { name: 'Odd', preset: 'nope', filters: { priority: '9', stages: 42 } }
    ])
    expect(parseSavedOdooTicketFilters(raw)[0]).toEqual({
      id: 'odd',
      name: 'Odd',
      preset: 'assigned',
      filters: DEFAULT_ODOO_TICKET_FILTERS
    })
  })
})

describe('upsertSavedOdooTicketFilter', () => {
  it('appends a new entry', () => {
    const next = upsertSavedOdooTicketFilter([], {
      name: 'Mine',
      preset: 'assigned',
      filters: MINE
    })
    expect(next).toEqual([{ id: 'mine', name: 'Mine', preset: 'assigned', filters: MINE }])
  })

  it('replaces in place when the normalised name already exists', () => {
    const existing = [saved('Mine'), saved('Other')]
    const next = upsertSavedOdooTicketFilter(existing, {
      name: '  MINE ',
      preset: 'all',
      filters: MINE
    })
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ id: 'mine', name: 'MINE', preset: 'all', filters: MINE })
    expect(next[1]?.name).toBe('Other')
  })

  it('ignores a blank name', () => {
    expect(upsertSavedOdooTicketFilter([], { name: '   ', preset: 'all', filters: MINE })).toEqual(
      []
    )
  })
})

describe('saved-filter cap', () => {
  const atCap = Array.from({ length: MAX_SAVED_FILTERS }, (_unused, index) =>
    saved(`F${index + 1}`)
  )

  it('drops the oldest entry when a new one pushes past the cap', () => {
    const next = upsertSavedOdooTicketFilter(atCap, {
      name: 'Newest',
      preset: 'all',
      filters: MINE
    })
    expect(next).toHaveLength(MAX_SAVED_FILTERS)
    expect(next.map((entry) => entry.id)).not.toContain('f1')
    expect(next.at(-1)?.id).toBe('newest')
  })

  it('leaves the list untouched when re-saving an existing entry at the cap', () => {
    const next = upsertSavedOdooTicketFilter(atCap, { name: 'F1', preset: 'all', filters: MINE })
    expect(next).toHaveLength(MAX_SAVED_FILTERS)
    expect(next[0]?.id).toBe('f1')
  })

  it('keeps the newest entries when a stored payload exceeds the cap', () => {
    // Same end as upsert evicts from, so a read shows what the next save keeps.
    const raw = JSON.stringify(
      Array.from({ length: MAX_SAVED_FILTERS + 1 }, (_unused, index) => ({
        name: `F${index + 1}`,
        preset: 'all',
        filters: {}
      }))
    )
    const parsed = parseSavedOdooTicketFilters(raw)
    expect(parsed).toHaveLength(MAX_SAVED_FILTERS)
    expect(parsed.map((entry) => entry.id)).not.toContain('f1')
    expect(parsed.at(-1)?.id).toBe(`f${MAX_SAVED_FILTERS + 1}`)
  })
})

describe('storage access', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  function stubThrowingStorage(): void {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem(): string {
            throw new Error('storage disabled')
          },
          setItem(): void {
            throw new Error('quota exceeded')
          }
        }
      }
    })
  }

  it('returns an empty list when reading storage throws', () => {
    stubThrowingStorage()
    expect(readSavedOdooTicketFilters()).toEqual([])
  })

  it('swallows a failing write so the calling handler still completes', () => {
    stubThrowingStorage()
    expect(() => writeSavedOdooTicketFilters([saved('Mine')])).not.toThrow()
  })
})

describe('legacy payload migration', () => {
  it('lifts a pre-multi-select single stage into the array', () => {
    const raw = JSON.stringify([{ name: 'Old', preset: 'all', filters: { stage: 'Review' } }])
    expect(parseSavedOdooTicketFilters(raw)[0]?.filters.stages).toEqual(['Review'])
  })

  it("treats the legacy 'all' sentinel as no stage filter", () => {
    const raw = JSON.stringify([{ name: 'Old', preset: 'all', filters: { stage: 'all' } }])
    expect(parseSavedOdooTicketFilters(raw)[0]?.filters.stages).toEqual([])
  })

  it('drops non-string entries from a stages array', () => {
    const raw = JSON.stringify([
      { name: 'Odd', preset: 'all', filters: { stages: ['Review', 7, 'Review'] } }
    ])
    expect(parseSavedOdooTicketFilters(raw)[0]?.filters.stages).toEqual(['Review'])
  })
})

describe('setDefaultSavedOdooTicketFilter', () => {
  it('stars one entry and clears the others', () => {
    const next = setDefaultSavedOdooTicketFilter([saved('A', { isDefault: true }), saved('B')], 'b')
    expect(next.map((entry) => entry.isDefault)).toEqual([undefined, true])
  })

  it('unstars when the already-default entry is picked again', () => {
    const next = setDefaultSavedOdooTicketFilter([saved('A', { isDefault: true })], 'a')
    expect(getDefaultSavedOdooTicketFilter(next)).toBeNull()
  })

  it('keeps a single default when the stored payload starred several', () => {
    const raw = JSON.stringify([
      { name: 'A', preset: 'all', filters: {}, isDefault: true },
      { name: 'B', preset: 'all', filters: {}, isDefault: true }
    ])
    const parsed = parseSavedOdooTicketFilters(raw)
    expect(parsed.filter((entry) => entry.isDefault)).toHaveLength(1)
    expect(getDefaultSavedOdooTicketFilter(parsed)?.name).toBe('A')
  })

  it('keeps the star when re-saving under the same name', () => {
    const next = upsertSavedOdooTicketFilter([saved('Mine', { isDefault: true })], {
      name: 'Mine',
      preset: 'all',
      filters: MINE
    })
    expect(next[0]?.isDefault).toBe(true)
  })
})

describe('removeSavedOdooTicketFilter', () => {
  it('drops only the matching id', () => {
    const next = removeSavedOdooTicketFilter([saved('Mine'), saved('Other')], 'mine')
    expect(next.map((entry) => entry.id)).toEqual(['other'])
  })
})

describe('toggleSavedOdooTicketFilterPin', () => {
  it('pins and unpins only the matching entry', () => {
    const list = [saved('A'), saved('B')]
    const pinned = toggleSavedOdooTicketFilterPin(list, 'a')
    expect(pinned.map((entry) => entry.pinned)).toEqual([true, undefined])
    expect(toggleSavedOdooTicketFilterPin(pinned, 'a')[0]?.pinned).toBeUndefined()
  })

  it('keeps the pin when re-saving under the same name', () => {
    const next = upsertSavedOdooTicketFilter([saved('Mine', { pinned: true })], {
      name: 'Mine',
      preset: 'all',
      filters: MINE
    })
    expect(next[0]?.pinned).toBe(true)
  })

  it('round-trips the pin through a stored payload', () => {
    const raw = JSON.stringify([
      { name: 'A', preset: 'all', filters: {}, pinned: true },
      { name: 'B', preset: 'all', filters: {} }
    ])
    expect(getPinnedSavedOdooTicketFilters(parseSavedOdooTicketFilters(raw))).toHaveLength(1)
  })
})

describe('reorderSavedOdooTicketFilters', () => {
  const list = [saved('A'), saved('B'), saved('C')]

  it('moves an entry down to the target slot', () => {
    expect(reorderSavedOdooTicketFilters(list, 'a', 'c').map((entry) => entry.id)).toEqual([
      'b',
      'c',
      'a'
    ])
  })

  it('moves an entry up to the target slot', () => {
    expect(reorderSavedOdooTicketFilters(list, 'c', 'a').map((entry) => entry.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  it('is a no-op for unknown or identical ids, without mutating the input', () => {
    expect(reorderSavedOdooTicketFilters(list, 'a', 'a').map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c'
    ])
    expect(reorderSavedOdooTicketFilters(list, 'nope', 'a').map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c'
    ])
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('drives the pinned chip order', () => {
    const pinned = [saved('A', { pinned: true }), saved('B'), saved('C', { pinned: true })]
    const next = reorderSavedOdooTicketFilters(pinned, 'c', 'a')
    expect(getPinnedSavedOdooTicketFilters(next).map((entry) => entry.id)).toEqual(['c', 'a'])
  })
})

describe('seedDefaultSavedOdooTicketFilters', () => {
  it('creates one pinned entry per seeded preset, starring the first', () => {
    const seeded = seedDefaultSavedOdooTicketFilters((preset) => `Label ${preset}`)
    expect(seeded.map((entry) => entry.preset)).toEqual([...ODOO_SEEDED_FILTER_PRESETS])
    expect(seeded.every((entry) => entry.pinned === true)).toBe(true)
    expect(getDefaultSavedOdooTicketFilter(seeded)?.preset).toBe(ODOO_SEEDED_FILTER_PRESETS[0])
  })

  it('produces entries the user can delete like any other', () => {
    const seeded = seedDefaultSavedOdooTicketFilters((preset) => `Label ${preset}`)
    const first = seeded[0]?.id ?? ''
    expect(removeSavedOdooTicketFilter(seeded, first).map((entry) => entry.id)).not.toContain(first)
  })
})

describe('isSavedOdooTicketFilterActive', () => {
  it('matches only when preset and every facet agree', () => {
    const entry = saved('Mine', { preset: 'all', filters: MINE })
    expect(isSavedOdooTicketFilterActive(entry, 'all', MINE)).toBe(true)
    expect(isSavedOdooTicketFilterActive(entry, 'assigned', MINE)).toBe(false)
    expect(isSavedOdooTicketFilterActive(entry, 'all', { ...MINE, tag: 'all' })).toBe(false)
    expect(isSavedOdooTicketFilterActive(entry, 'all', { ...MINE, stages: [] })).toBe(false)
  })
})
