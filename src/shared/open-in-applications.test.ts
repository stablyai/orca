import { describe, expect, it } from 'vitest'
import { DEFAULT_OPEN_IN_APPLICATIONS, normalizeOpenInApplications } from './open-in-applications'
import { MAX_OPEN_IN_APP_ICON_DATA_URL_LENGTH } from './open-in-app-icons'

// A 1x1 PNG, standing in for what icon extraction returns for a picked app.
const PNG_1X1_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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

  it('keeps icons this build can render and drops the rest', () => {
    const rows = normalizeOpenInApplications([
      { id: 'a', label: 'IDEA', command: 'idea', icon: { type: 'bundled', id: 'Braces' } },
      { id: 'b', label: 'Fleet', command: 'fleet', icon: { type: 'bundled', id: 'NotAnIcon' } },
      { id: 'c', label: 'Xcode', command: 'xed', icon: 'Braces' },
      {
        id: 'd',
        label: 'Zed',
        command: 'zed',
        icon: { type: 'image', src: PNG_1X1_DATA_URL }
      },
      {
        id: 'e',
        label: 'Remote',
        command: 'ssh',
        icon: { type: 'image', src: 'https://example.com/icon.png' }
      },
      {
        id: 'f',
        label: 'Svg',
        command: 'svg',
        icon: { type: 'image', src: 'data:image/svg+xml;base64,aGk=' }
      }
    ])

    expect(rows).toEqual([
      { id: 'a', label: 'IDEA', command: 'idea', icon: { type: 'bundled', id: 'Braces' } },
      { id: 'b', label: 'Fleet', command: 'fleet' },
      { id: 'c', label: 'Xcode', command: 'xed' },
      {
        id: 'd',
        label: 'Zed',
        command: 'zed',
        icon: { type: 'image', src: PNG_1X1_DATA_URL }
      },
      { id: 'e', label: 'Remote', command: 'ssh' },
      { id: 'f', label: 'Svg', command: 'svg' }
    ])
    for (const index of [1, 2, 4, 5]) {
      expect(rows[index]).not.toHaveProperty('icon')
    }
  })

  it('drops a picked icon too large to sync to paired clients', () => {
    const oversized = `data:image/png;base64,${'A'.repeat(MAX_OPEN_IN_APP_ICON_DATA_URL_LENGTH)}`
    const [row] = normalizeOpenInApplications([
      { id: 'a', label: 'IDEA', command: 'idea', icon: { type: 'image', src: oversized } }
    ])

    expect(row).not.toHaveProperty('icon')
  })

  it('seeds defaults only when the persisted field is missing', () => {
    expect(normalizeOpenInApplications(undefined, { seedDefaults: true })).toEqual(
      DEFAULT_OPEN_IN_APPLICATIONS
    )
    expect(normalizeOpenInApplications([], { seedDefaults: true })).toEqual([])
  })
})
