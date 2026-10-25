import { describe, expect, it } from 'vitest'
import { TerminalCreateParams } from './terminal-unary-params'
import { resolveWindowsShellStartupFamily } from '../windows-terminal-shell'

describe('TerminalCreateParams.shell', () => {
  it('stays optional so older callers keep creating terminals', () => {
    const parsed = TerminalCreateParams.parse({ worktree: 'path:/repo' })

    expect(parsed.shell).toBeUndefined()
  })

  it('carries an allowed Windows shell through to the runtime', () => {
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd.exe' }).shell).toBe(
      'cmd.exe'
    )
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'git-bash' }).shell).toBe(
      'git-bash'
    )
  })

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

  it('quotes a bare cmd override as cmd rather than PowerShell', () => {
    const { shell } = TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd' })

    expect(resolveWindowsShellStartupFamily(shell)).toBe('cmd')
  })

  // Refuse unsupported shells before terminal creation instead of returning an opaque relay spawn failure.
  it('refuses a shell the host will not spawn', () => {
    expect(() => TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'nu.exe' })).toThrow(
      /shell must be one of/
    )
    expect(() =>
      TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd.exe && calc' })
    ).toThrow(/shell must be one of/)
  })
})
