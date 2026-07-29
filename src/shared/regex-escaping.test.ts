import { describe, expect, it } from 'vitest'
import { escapeRegex } from './regex-escaping'

describe('escapeRegex', () => {
  it('escapes every regular expression metacharacter', () => {
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
  })

  it('leaves ordinary text unchanged', () => {
    expect(escapeRegex('orca-10982')).toBe('orca-10982')
  })
})
