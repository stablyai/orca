import { describe, expect, it } from 'vitest'
import { TerminalCreateParams } from './terminal-unary-params'

describe('TerminalCreateParams.shell', () => {
  // Host canonicalization must supply the .exe spellings exact-matched by spawn and command quoting.
  it('canonicalizes an accepted spelling before it reaches the runtime', () => {
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd' }).shell).toBe(
      'cmd.exe'
    )
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'pwsh' }).shell).toBe(
      'pwsh.exe'
    )
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'Git-Bash' }).shell).toBe(
      'git-bash'
    )
  })
})
