import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { isXtermInstanceDisposed } from './xterm-instance-disposed'

describe('isXtermInstanceDisposed', () => {
  it('tracks dispose on the real vendored xterm build', () => {
    // Pinned against the vendored build on purpose: if an xterm upgrade moves
    // the private field, this must fail loudly — the probe silently returning
    // false would blind the zombie-pane instrumentation.
    const terminal = new Terminal({ allowProposedApi: true })
    expect(isXtermInstanceDisposed(terminal)).toBe(false)
    terminal.dispose()
    expect(isXtermInstanceDisposed(terminal)).toBe(true)
  })

  it('answers false for non-terminal shapes', () => {
    expect(isXtermInstanceDisposed(null)).toBe(false)
    expect(isXtermInstanceDisposed(undefined)).toBe(false)
    expect(isXtermInstanceDisposed({})).toBe(false)
  })
})
