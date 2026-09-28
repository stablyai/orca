import { describe, expect, it } from 'vitest'
import {
  ORCA_SESSION_ADDRESS_PREFIX,
  formatOrcaSessionAddress,
  isOrcaSessionId,
  parseOrcaSessionAddress
} from './orca-session-address'
import { testOrcaSessionId } from './orca-session-address-test-fixture'

const SESSION_ID = testOrcaSessionId('0b7e4c2a-5f1d-4e8a-9c3b-2d6f8a1e4b70')
const ADDRESS = `session:${SESSION_ID}`

describe('Orca session address', () => {
  it('addresses an Orca session id as session:<id> and parses the bare id back', () => {
    expect(ORCA_SESSION_ADDRESS_PREFIX).toBe('session:')
    expect(formatOrcaSessionAddress(SESSION_ID)).toBe(ADDRESS)
    expect(parseOrcaSessionAddress(ADDRESS)).toBe(SESSION_ID)
    const parsed = parseOrcaSessionAddress(ADDRESS)
    expect(parsed && formatOrcaSessionAddress(parsed)).toBe(ADDRESS)
  })

  it('reads only the addressed spelling when parsing an address', () => {
    // A bare id is what the columns store, not an address.
    expect(parseOrcaSessionAddress(SESSION_ID)).toBeNull()
    expect(parseOrcaSessionAddress(null)).toBeNull()
    expect(parseOrcaSessionAddress(undefined)).toBeNull()
    expect(parseOrcaSessionAddress('')).toBeNull()
  })

  it.each([
    ['an unknown prefix', `pane:${SESSION_ID}`],
    ['the Run mailbox namespace', 'run:run_123'],
    ['the Dispatch mailbox namespace', 'dispatch:ctx_123'],
    ['an empty prefix', `:${SESSION_ID}`],
    ['an empty id', 'session:'],
    ['an id with a separator', `session:${SESSION_ID}:extra`],
    ['an id the session predicate rejects', 'session:short'],
    ['a terminal handle', 'term_4f2c9a']
  ])('refuses %s', (_label, value) => {
    expect(parseOrcaSessionAddress(value)).toBeNull()
  })

  it.each([
    ['a PTY terminal handle', 'term_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c'],
    ['a short PTY terminal handle', 'term_4f2c9a'],
    ['a structured-worker handle', 'structworker_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c']
  ])('never treats %s as an Orca session id', (_label, handle) => {
    // Handles share the session-id charset, so the session-record predicate alone would accept them.
    expect(isOrcaSessionId(handle)).toBe(false)
    expect(parseOrcaSessionAddress(`session:${handle}`)).toBeNull()
  })

  it('validates an Orca session id with the session-record predicate', () => {
    expect(isOrcaSessionId(SESSION_ID)).toBe(true)
    expect(isOrcaSessionId('has space in it')).toBe(false)
    expect(isOrcaSessionId('x'.repeat(129))).toBe(false)
  })
})
