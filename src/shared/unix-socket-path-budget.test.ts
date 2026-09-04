import { describe, expect, it } from 'vitest'
import {
  measureUnixSocketPathBudget,
  UNIX_SOCKET_PATH_LIMIT,
  unixSocketPathBytes
} from './unix-socket-path-budget'

describe('unix socket path bytes', () => {
  it('counts bytes, not characters', () => {
    // A data root with an accented component spends more budget than its length suggests,
    // and a character count would report a path that does not fit as fitting.
    expect('/home/josé/.orca'.length).toBe(16)
    expect(unixSocketPathBytes('/home/josé/.orca')).toBe(17)
  })

  it('agrees with length for ASCII', () => {
    expect(unixSocketPathBytes('/tmp/x')).toBe(6)
  })
})

describe('budget measurement', () => {
  it('reports the longest candidate, not the first', () => {
    const budget = measureUnixSocketPathBudget(['/tmp/short', '/tmp/a-much-longer-name'])
    expect(budget.longestPath).toBe('/tmp/a-much-longer-name')
    expect(budget.bytes).toBe('/tmp/a-much-longer-name'.length)
  })

  it('fits exactly at the limit and not one byte past it', () => {
    const exact = `/${'x'.repeat(UNIX_SOCKET_PATH_LIMIT - 1)}`
    expect(unixSocketPathBytes(exact)).toBe(UNIX_SOCKET_PATH_LIMIT)
    expect(measureUnixSocketPathBudget([exact]).fits).toBe(true)
    expect(measureUnixSocketPathBudget([`${exact}x`]).fits).toBe(false)
  })
})
