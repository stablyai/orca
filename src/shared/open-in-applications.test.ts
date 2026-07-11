import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPEN_IN_APPLICATIONS,
  moveOpenInApplicationToFront,
  normalizeOpenInApplications
} from './open-in-applications'

describe('normalizeOpenInApplications', () => {
  it('trims fields, drops invalid rows, keeps first duplicate id, and caps list', () => {
    const rows = normalizeOpenInApplications([
      { id: 'a', label: ' Cursor ', command: ' cursor ' },
      { id: 'a', label: 'Dup', command: 'dup' },
      { id: 'b', label: '   ', command: 'zed' },
      { id: 'c', label: 'Zed', command: '   ' },
      { id: 'd', label: 'D', command: 'd' },
      { id: 'e', label: 'E', command: 'e' },
      { id: 'f', label: 'F', command: 'f' },
      { id: 'g', label: 'G', command: 'g' },
      { id: 'h', label: 'H', command: 'h' },
      { id: 'i', label: 'I', command: 'i' },
      { id: 'j', label: 'J', command: 'j' }
    ])

    expect(rows).toEqual([
      { id: 'a', label: 'Cursor', command: 'cursor' },
      { id: 'd', label: 'D', command: 'd' },
      { id: 'e', label: 'E', command: 'e' },
      { id: 'f', label: 'F', command: 'f' },
      { id: 'g', label: 'G', command: 'g' },
      { id: 'h', label: 'H', command: 'h' },
      { id: 'i', label: 'I', command: 'i' },
      { id: 'j', label: 'J', command: 'j' }
    ])
  })

  it('generates ids for missing or blank ids', () => {
    let counter = 0
    const rows = normalizeOpenInApplications(
      [
        { label: 'Cursor', command: 'cursor' },
        { id: '   ', label: 'Zed', command: 'zed' }
      ],
      { createId: () => `gen-${++counter}` }
    )

    expect(rows).toEqual([
      { id: 'gen-1', label: 'Cursor', command: 'cursor' },
      { id: 'gen-2', label: 'Zed', command: 'zed' }
    ])
  })

  it('seeds defaults only when the persisted field is missing', () => {
    expect(normalizeOpenInApplications(undefined, { seedDefaults: true })).toEqual(
      DEFAULT_OPEN_IN_APPLICATIONS
    )
    expect(normalizeOpenInApplications([], { seedDefaults: true })).toEqual([])
  })
})

describe('moveOpenInApplicationToFront', () => {
  const apps = [
    { id: 'a', label: 'A', command: 'a' },
    { id: 'b', label: 'B', command: 'b' },
    { id: 'c', label: 'C', command: 'c' }
  ]

  it('moves a matching non-first id to the front', () => {
    expect(moveOpenInApplicationToFront(apps, 'c')).toEqual([
      { id: 'c', label: 'C', command: 'c' },
      { id: 'a', label: 'A', command: 'a' },
      { id: 'b', label: 'B', command: 'b' }
    ])
  })

  it('returns the same array reference when already first or not found', () => {
    expect(moveOpenInApplicationToFront(apps, 'a')).toBe(apps)
    expect(moveOpenInApplicationToFront(apps, 'missing')).toBe(apps)
  })
})
