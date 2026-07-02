import { describe, expect, it } from 'vitest'
import { formatCell } from './data-grid-cell-format'

describe('formatCell', () => {
  it('renders NULL distinct from an empty string', () => {
    expect(formatCell(null)).toEqual({ text: 'NULL', isNull: true })
    expect(formatCell(undefined)).toEqual({ text: 'NULL', isNull: true })
    expect(formatCell('')).toEqual({ text: '', isNull: false })
  })

  it('renders a Date as ISO, not a JSON-quoted string', () => {
    expect(formatCell(new Date('2024-01-02T03:04:05.000Z'))).toEqual({
      text: '2024-01-02T03:04:05.000Z',
      isNull: false
    })
  })

  it('renders binary columns as a byte count, not a byte dump', () => {
    expect(formatCell(new Uint8Array([1, 2, 3, 4]))).toEqual({ text: '[4 bytes]', isNull: false })
  })

  it('stringifies plain objects/arrays', () => {
    expect(formatCell({ a: 1 })).toEqual({ text: '{"a":1}', isNull: false })
    expect(formatCell([1, 2])).toEqual({ text: '[1,2]', isNull: false })
  })

  it('stringifies scalars', () => {
    expect(formatCell(42)).toEqual({ text: '42', isNull: false })
    expect(formatCell(true)).toEqual({ text: 'true', isNull: false })
  })
})
