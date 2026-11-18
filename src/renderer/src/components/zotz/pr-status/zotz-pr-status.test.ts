import { describe, expect, it } from 'vitest'
import { zotzPrStatus } from './zotz-pr-status'

const base = { provider: 'github' as const, number: 7, title: 'x' }

describe('zotzPrStatus', () => {
  it('reads what to do next, most actionable first', () => {
    expect(zotzPrStatus({ ...base, state: 'merged', status: 'failure' })).toBe('merged')
    expect(zotzPrStatus({ ...base, state: 'open', status: 'failure' })).toBe('failing')
    expect(zotzPrStatus({ ...base, state: 'open', status: 'pending' })).toBe('pending')
    expect(zotzPrStatus({ ...base, state: 'open', status: 'success' })).toBe('ready')
    expect(zotzPrStatus({ ...base, state: 'draft', status: 'success' })).toBe('draft')
  })
})
