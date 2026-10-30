import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { isXtermInstanceDisposed } from './xterm-instance-disposed'

describe('isXtermInstanceDisposed', () => {
  it('tracks dispose on the real vendored xterm build', () => {
    // Pin the private disposed field to vendored xterm; silent false after an upgrade would blind zombie-pane diagnostics.
    const terminal = new Terminal({ allowProposedApi: true })
    expect(isXtermInstanceDisposed(terminal)).toBe(false)
    terminal.dispose()
    expect(isXtermInstanceDisposed(terminal)).toBe(true)
  })
})
