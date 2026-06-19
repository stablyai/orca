import { describe, expect, it } from 'vitest'
import { buildTerminalCapabilityEnv } from './terminal-capability-env'

describe('buildTerminalCapabilityEnv', () => {
  it('advertises xterm.js-compatible hyperlink capabilities and Orca identity', () => {
    const env = buildTerminalCapabilityEnv('1.2.3')

    expect(env).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'vscode',
      TERM_PROGRAM_VERSION: '1.100.0',
      ORCA_TERM_PROGRAM: 'Orca',
      ORCA_TERM_PROGRAM_VERSION: '1.2.3',
      FORCE_HYPERLINK: '1'
    })
  })
})
