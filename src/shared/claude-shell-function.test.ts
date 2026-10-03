import type * as ProfileRouting from './claude-profile-routing'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const gate = vi.hoisted(() => ({ enabled: true }))
vi.mock('./claude-profile-routing', async (original) => ({
  ...(await original<typeof ProfileRouting>()),
  claudeProfileRoutingEnabled: () => gate.enabled
}))
import { WSL_CLAUDE_PROFILE_POINTER } from './claude-profile-routing'
import {
  getPosixClaudeShellFunction,
  getFishClaudeShellFunction,
  getPowerShellClaudeShellFunction
} from './claude-shell-function'
// Why filtered: CI images lack zsh and fish; a missing shell skips rather than exits 127.
const POSIX_SHELLS = ['/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell))
const FISH =
  ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(existsSync) ?? ''
const NO_ACCOUNT_READY =
  'No Claude account is ready for this terminal. Open Orca Settings > Accounts to sign in again or choose System default.'
const roots: string[] = []
afterEach(() => {
  gate.enabled = true
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-shell-'))
  roots.push(root)
  const a = join(root, 'account a ü')
  const b = join(root, 'account b')
  const bin = join(root, 'bin')
  for (const dir of [a, b, bin]) {
    mkdirSync(dir)
  }
  writeFileSync(
    join(bin, 'claude'),
    '#!/bin/sh\n[ "$1" != hold ] || { : > "$HOME/hold-started"; sleep 0.1; }\nprintf "HOME=%s KEY=%s ARG=%s TWIN=%s\\n" "${CLAUDE_CONFIG_DIR-default}" "${ANTHROPIC_API_KEY-none}" "$1" "${ORCA_CLAUDE_INJECTED_CONFIG_DIR-none}"\nexit 23\n'
  )
  chmodSync(join(bin, 'claude'), 0o700)
  const pointer = join(root, 'selected')
  writeFileSync(pointer, a)
  const fake = join(bin, 'claude')
  const run = (shell: string, text: string, env: string[] = []) => {
    const fish = shell.endsWith('fish')
    // Why: a shell that reads system config can put a real claude ahead of the fake; abort first.
    const guard = fish
      ? `test (command -s claude) = '${fake}'; or exit 97`
      : `[ "$(command -v claude)" = '${fake}' ] || exit 97`
    const result = spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${root}`,
        `PATH=${bin}:/usr/bin:/bin`,
        `ORCA_CLAUDE_PROFILE_POINTER=${pointer}`,
        'ANTHROPIC_API_KEY=fake',
        ...env,
        shell,
        ...(fish ? ['--no-config'] : shell.endsWith('zsh') ? ['-f'] : ['--noprofile', '--norc']),
        '-c',
        `${guard}\n${text}`
      ],
      { encoding: 'utf8', cwd: root }
    )
    if (result.status === 97) {
      throw new Error(`${shell} did not resolve claude to the fake binary`)
    }
    return result
  }
  return { root, a, b, pointer, run }
}
describe('Claude invocation account selection', () => {
  it.each(POSIX_SHELLS)(
    'switches the next invocation in the same %s while a running child keeps its home',
    (shell) => {
      const f = fixture()
      const result = f.run(
        shell,
        // Why wait for the child: a fixed sleep raced the child's pointer read on a loaded machine.
        `${getPosixClaudeShellFunction()}\nclaude hold & child=$!\nwhile [ ! -e "$HOME/hold-started" ]; do sleep 0.01; done\nprintf '%s' '${f.b}' > "$ORCA_CLAUDE_PROFILE_POINTER"\nclaude 'two words'\nwait "$child"`
      )
      expect(result.stdout).toContain(`HOME=${f.a} KEY=none ARG=hold TWIN=${f.a}`)
      expect(result.stdout).toContain(`HOME=${f.b} KEY=none ARG=two words TWIN=${f.b}`)
      expect(result.status).toBe(23)
    }
  )
  it.each(POSIX_SHELLS)(
    'refuses unreadable/missing and malformed selections and keeps explicit default auth in %s',
    (shell) => {
      const f = fixture()
      for (const value of ['\n', `${f.a}\n`, '/missing-profile', 'relative', `${f.a}\0`]) {
        writeFileSync(f.pointer, value)
        const result = f.run(shell, `${getPosixClaudeShellFunction()}\nclaude test`)
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).not.toBe('')
      }
      rmSync(f.pointer)
      const missing = f.run(shell, `${getPosixClaudeShellFunction()}\nclaude test`)
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain(NO_ACCOUNT_READY)
      writeFileSync(f.pointer, '')
      expect(f.run(shell, `${getPosixClaudeShellFunction()}\nclaude default`).stdout).toContain(
        'HOME=default KEY=fake'
      )
    }
  )
  it.each(POSIX_SHELLS)(
    'in %s a hand-exported CLAUDE_CONFIG_DIR wins; Orca’s own spawn value re-resolves',
    (shell) => {
      const f = fixture()
      const fn = getPosixClaudeShellFunction()
      const user = f.run(shell, `${fn}\nclaude x`, ['CLAUDE_CONFIG_DIR=/user/own'])
      expect(user.stdout).toBe('HOME=/user/own KEY=fake ARG=x TWIN=none\n')
      writeFileSync(f.pointer, '')
      const injected = [`CLAUDE_CONFIG_DIR=${f.b}`, `ORCA_CLAUDE_INJECTED_CONFIG_DIR=${f.b}`]
      expect(f.run(shell, `${fn}\nclaude x`, injected).stdout).toBe(
        'HOME=default KEY=fake ARG=x TWIN=none\n'
      )
      writeFileSync(f.pointer, f.a)
      expect(f.run(shell, `${fn}\nclaude x`, injected).stdout).toContain(`HOME=${f.a} KEY=none`)
    }
  )
  it.each(POSIX_SHELLS)(
    'in %s leaves claude alone without a routed pane or with the user’s own wrapper',
    (shell) => {
      const f = fixture()
      const fn = getPosixClaudeShellFunction()
      const unrouted = `unset ORCA_CLAUDE_PROFILE_POINTER\n${fn}\nclaude remote`
      expect(f.run(shell, unrouted).stdout).toBe('HOME=default KEY=fake ARG=remote TWIN=none\n')
      const wrapper = `function claude { echo USER-WRAPPER; command claude "$@"; }\n${fn}\nclaude x`
      expect(f.run(shell, wrapper).stdout).toContain('USER-WRAPPER')
    }
  )
  it.each(POSIX_SHELLS)('in %s accepts Git Bash drive-form pointers', (shell) => {
    const f = fixture()
    for (const value of ['C:\\profile', 'C:/profile']) {
      // The cwd-relative stand-in lets the drive form pass `test -d` on this POSIX host.
      mkdirSync(join(f.root, value), { recursive: true })
      writeFileSync(f.pointer, value)
      expect(f.run(shell, `${getPosixClaudeShellFunction()}\nclaude x`).stdout).toContain(
        `HOME=${value} KEY=none`
      )
    }
  })
  it.each([...POSIX_SHELLS, ...(FISH ? [FISH] : [])])(
    'in %s expands a WSL pane’s guest-relative pointer against $HOME at each invocation',
    (shell) => {
      const f = fixture()
      const fn = shell.endsWith('fish')
        ? getFishClaudeShellFunction()
        : getPosixClaudeShellFunction()
      const relative = [`ORCA_CLAUDE_PROFILE_POINTER=${WSL_CLAUDE_PROFILE_POINTER}`]
      const guestPointer = join(f.root, '.local/share/orca/claude-profiles/selected-wsl')
      const unread = f.run(shell, `${fn}\nclaude x`, relative)
      expect([unread.status, unread.stdout]).toEqual([1, ''])
      expect(unread.stderr).toContain(NO_ACCOUNT_READY)
      mkdirSync(join(f.root, '.local/share/orca/claude-profiles'), { recursive: true })
      writeFileSync(guestPointer, f.b)
      expect(f.run(shell, `${fn}\nclaude x`, relative).stdout).toBe(
        `HOME=${f.b} KEY=none ARG=x TWIN=${f.b}\n`
      )
      writeFileSync(guestPointer, join(f.root, 'missing'))
      const missing = f.run(shell, `${fn}\nclaude x`, relative)
      expect([missing.status, missing.stdout]).toEqual([1, ''])
    }
  )
  it.each(POSIX_SHELLS)(
    'in %s refuses a guest-relative pointer cleanly under set -u with HOME unset',
    (shell) => {
      const f = fixture()
      const relative = [`ORCA_CLAUDE_PROFILE_POINTER=${WSL_CLAUDE_PROFILE_POINTER}`]
      const fn = getPosixClaudeShellFunction()
      const result = f.run(shell, `${fn}\nunset HOME\nset -u\nclaude x`, relative)
      expect([result.status, result.stdout]).toEqual([1, ''])
      expect(result.stderr).toContain(NO_ACCOUNT_READY)
    }
  )
  it('preserves dormant generated scripts byte for byte', () => {
    gate.enabled = false
    expect([
      getPosixClaudeShellFunction(),
      getFishClaudeShellFunction(),
      getPowerShellClaudeShellFunction()
    ]).toEqual(['', '', ''])
  })
  it.skipIf(!FISH)('uses the same pointer and override rule in fish', () => {
    const f = fixture()
    const fn = getFishClaudeShellFunction()
    const result = f.run(FISH, `${fn}\nclaude 'two words'`)
    expect(result.stdout).toContain(`HOME=${f.a} KEY=none ARG=two words TWIN=${f.a}`)
    expect(result.status).toBe(23)
    expect(f.run(FISH, `${fn}\nclaude x`, ['CLAUDE_CONFIG_DIR=/user/own']).stdout).toBe(
      'HOME=/user/own KEY=fake ARG=x TWIN=none\n'
    )
    mkdirSync(join(f.root, 'C:\\profile'))
    writeFileSync(f.pointer, 'C:\\profile')
    expect(f.run(FISH, `${fn}\nclaude x`).stdout).toContain('HOME=C:\\profile KEY=none')
    writeFileSync(f.pointer, '')
    expect(f.run(FISH, `${fn}\nclaude x`).stdout).toBe('HOME=default KEY=fake ARG=x TWIN=none\n')
    for (const value of ['\n', `${f.a}\n`]) {
      writeFileSync(f.pointer, value)
      expect(f.run(FISH, `${fn}\nclaude test`).stdout).toBe('')
    }
    expect(f.run(FISH, `set -e ORCA_CLAUDE_PROFILE_POINTER\n${fn}\nclaude x`).stdout).toContain(
      'HOME=default KEY=fake'
    )
  })
  it('uses no fish syntax newer than the 3.x releases Orca supports', () => {
    // `string collect --allow-empty` arrived in fish 3.4; older fish refused every launch.
    expect(getFishClaudeShellFunction()).not.toMatch(/string collect|--allow-empty/)
  })
  it('emits a guarded PowerShell per-invocation read, override rule and finally restoration', () => {
    const script = getPowerShellClaudeShellFunction()
    expect(script.startsWith('\n$orcaClaudeCommand = Get-Command claude')).toBe(true)
    expect(script).toContain('[IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER)')
    // A missing pointer says what to do instead of surfacing a .NET FileNotFoundException.
    expect(script).toContain(
      `if (-not [IO.File]::Exists($env:ORCA_CLAUDE_PROFILE_POINTER)) { throw '${NO_ACCOUNT_READY}' }`
    )
    expect(script).toContain('$env:CLAUDE_CONFIG_DIR -eq $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR')
    expect(script).toContain("throw 'Selected Claude profile")
    expect(script).toContain('finally {')
    // .NET 9+ turns a $null/'' SetEnvironmentVariable into an empty variable, not a removal.
    expect(script).not.toMatch(/SetEnvironmentVariable\([^)]*,\s*(\$null|''|"")\s*,/)
    expect(script).toContain(
      'if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }'
    )
    expect(script).toContain('$input | & $binary.Source @args')
  })
})
