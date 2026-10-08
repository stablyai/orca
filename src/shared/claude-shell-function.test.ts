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
import {
  getPosixClaudeShellFunction,
  getFishClaudeShellFunction,
  getPowerShellClaudeShellFunction
} from './claude-shell-function'
// Why filtered: CI images lack zsh and fish; a missing shell skips rather than exits 127.
const POSIX_SHELLS = ['/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell))
const FISH = ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find(existsSync)
const SHELLS = [...POSIX_SHELLS, ...(FISH ? [FISH] : [])]
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
  const fake = join(bin, 'claude')
  writeFileSync(
    fake,
    '#!/bin/sh\nprintf "HOME=%s KEY=%s TWIN=%s\\n" "${CLAUDE_CONFIG_DIR-default}" "${ANTHROPIC_API_KEY-none}" "${ORCA_CLAUDE_INJECTED_CONFIG_DIR-none}"\nexit 23\n'
  )
  chmodSync(fake, 0o700)
  const pointer = join(root, 'selected')
  const run = (shell: string, env: string[] = []) => {
    const fish = shell.endsWith('fish')
    const fn = fish ? getFishClaudeShellFunction() : getPosixClaudeShellFunction()
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
        ...(fish ? ['--no-config'] : shell.endsWith('zsh') ? ['-f'] : ['--norc', '--noprofile']),
        '-c',
        `${guard}\n${fn}\nclaude`
      ],
      { encoding: 'utf8', cwd: root }
    )
    expect(result.status).not.toBe(97)
    return result
  }
  return { a, b, pointer, run }
}
const injected = (home: string) => [
  `CLAUDE_CONFIG_DIR=${home}`,
  `ORCA_CLAUDE_INJECTED_CONFIG_DIR=${home}`
]

describe.each(SHELLS)('the claude function in %s', (shell) => {
  it('re-reads the selection on every launch and strips ambient auth for an account', () => {
    const f = fixture()
    writeFileSync(f.pointer, f.a)
    expect(f.run(shell, injected(f.b)).stdout).toBe(`HOME=${f.a} KEY=none TWIN=${f.a}\n`)
    writeFileSync(f.pointer, f.b)
    const next = f.run(shell, injected(f.a))
    expect(next.stdout).toBe(`HOME=${f.b} KEY=none TWIN=${f.b}\n`)
    expect(next.status).toBe(23)
  })

  it('runs System default for an empty or missing selection, dropping only Orca’s own value', () => {
    const f = fixture()
    expect(f.run(shell).stdout).toBe('HOME=default KEY=fake TWIN=none\n')
    expect(f.run(shell, injected(f.a)).stdout).toBe('HOME=default KEY=fake TWIN=none\n')
    writeFileSync(f.pointer, '')
    expect(f.run(shell, injected(f.a)).stdout).toBe('HOME=default KEY=fake TWIN=none\n')
  })

  it('reads a WSL pane’s home-relative pointer against $HOME', () => {
    const f = fixture()
    writeFileSync(f.pointer, f.a)
    const relative = f.run(shell, ['ORCA_CLAUDE_PROFILE_POINTER=~/selected'])
    expect(relative.stdout).toBe(`HOME=${f.a} KEY=none TWIN=${f.a}\n`)
  })

  it('refuses a selected account whose folder is missing', () => {
    const f = fixture()
    writeFileSync(f.pointer, join(f.a, 'gone'))
    const result = f.run(shell)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('folder is missing')
  })

  it('lets the user’s own CLAUDE_CONFIG_DIR win and says so when an account is selected', () => {
    const f = fixture()
    const own = f.run(shell, ['CLAUDE_CONFIG_DIR=/user/own'])
    expect(own.stdout).toBe('HOME=/user/own KEY=fake TWIN=none\n')
    expect(own.stderr).toBe('')
    writeFileSync(f.pointer, f.a)
    const overridden = f.run(shell, ['CLAUDE_CONFIG_DIR=/user/own'])
    expect(overridden.stdout).toBe('HOME=/user/own KEY=fake TWIN=none\n')
    expect(overridden.stderr).toContain('not used here')
  })
})

it('emits nothing while routing is off', () => {
  gate.enabled = false
  expect([
    getPosixClaudeShellFunction(),
    getFishClaudeShellFunction(),
    getPowerShellClaudeShellFunction()
  ]).toEqual(['', '', ''])
})

it('restores PowerShell process env without creating empty variables', () => {
  const script = getPowerShellClaudeShellFunction()
  expect(script.startsWith('\n$orcaClaudeCommand = Get-Command claude')).toBe(true)
  expect(script).toContain('finally {')
  // .NET 9+ turns a $null/'' SetEnvironmentVariable into an empty variable, not a removal.
  expect(script).not.toMatch(/SetEnvironmentVariable\([^)]*,\s*(\$null|''|"")\s*,/)
})

it('trims the PowerShell pointer read as POSIX command substitution does', () => {
  expect(getPowerShellClaudeShellFunction()).toContain(
    '[IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER).TrimEnd()'
  )
})
