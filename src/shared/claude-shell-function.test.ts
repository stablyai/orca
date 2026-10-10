import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
  const run = (shell: string, env: string[] = [], fakeKind: 'summary' | 'printenv' = 'summary') => {
    if (fakeKind === 'printenv') {
      writeFileSync(fake, '#!/bin/sh\nenv\n')
    }
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
    // Orca prints nothing into a terminal; the fake claude writes only to stdout.
    expect(result.stderr).toBe('')
    return result
  }
  return { a, b, pointer, run }
}
const injected = (home: string) => [
  `CLAUDE_CONFIG_DIR=${home}`,
  `ORCA_CLAUDE_INJECTED_CONFIG_DIR=${home}`
]

describe.each(SHELLS)('the claude function in %s', (shell) => {
  it("re-reads the selection on every launch and keeps the shell's auth for an account", () => {
    const f = fixture()
    writeFileSync(f.pointer, f.a)
    expect(f.run(shell, injected(f.b)).stdout).toBe(`HOME=${f.a} KEY=fake TWIN=${f.a}\n`)
    writeFileSync(f.pointer, f.b)
    const next = f.run(shell, injected(f.a))
    expect(next.stdout).toBe(`HOME=${f.b} KEY=fake TWIN=${f.b}\n`)
    expect(next.status).toBe(23)
  })

  it("passes a shell proxy's key and address through to an account", () => {
    const f = fixture()
    writeFileSync(f.pointer, f.a)
    const env = [
      'ANTHROPIC_API_KEY=proxy-key',
      'ANTHROPIC_AUTH_TOKEN=proxy-token',
      'ANTHROPIC_BASE_URL=https://proxy.example.test',
      'ANTHROPIC_CUSTOM_HEADERS=Authorization: Bearer x'
    ]
    const printed = f.run(shell, env, 'printenv').stdout
    for (const line of [...env, `CLAUDE_CONFIG_DIR=${f.a}`]) {
      expect(printed).toContain(`${line}\n`)
    }
  })

  it('runs System default for an empty or missing selection, dropping only Orca’s own value', () => {
    const f = fixture()
    expect(f.run(shell).stdout).toBe('HOME=default KEY=fake TWIN=none\n')
    expect(f.run(shell, injected(f.a)).stdout).toBe('HOME=default KEY=fake TWIN=none\n')
    writeFileSync(f.pointer, '')
    expect(f.run(shell, injected(f.a)).stdout).toBe('HOME=default KEY=fake TWIN=none\n')
  })

  it('restores the user’s own value Orca replaced when switched back to System default', () => {
    const f = fixture()
    const own = ['ORCA_CLAUDE_USER_CONFIG_DIR=/user/own']
    writeFileSync(f.pointer, f.a)
    const account = f.run(shell, [...injected(f.a), ...own])
    expect(account.stdout).toBe(`HOME=${f.a} KEY=fake TWIN=${f.a}\n`)
    writeFileSync(f.pointer, '')
    const restored = f.run(shell, [...injected(f.a), ...own])
    expect(restored.stdout).toBe('HOME=/user/own KEY=fake TWIN=none\n')
    // An rc export still wins, and a value the user unset stays unset.
    const rc = ['CLAUDE_CONFIG_DIR=/rc/own', `ORCA_CLAUDE_INJECTED_CONFIG_DIR=${f.a}`, ...own]
    expect(f.run(shell, rc).stdout).toBe(`HOME=/rc/own KEY=fake TWIN=${f.a}\n`)
    const unset = f.run(shell, [`ORCA_CLAUDE_INJECTED_CONFIG_DIR=${f.a}`, ...own])
    expect(unset.stdout).toBe('HOME=default KEY=fake TWIN=none\n')
  })

  it('reads a WSL pane’s home-relative pointer against $HOME', () => {
    const f = fixture()
    writeFileSync(f.pointer, f.a)
    const relative = f.run(shell, ['ORCA_CLAUDE_PROFILE_POINTER=~/selected'])
    expect(relative.stdout).toBe(`HOME=${f.a} KEY=fake TWIN=${f.a}\n`)
  })

  it('creates a missing account folder and runs Claude in it, printing nothing', () => {
    const f = fixture()
    // A pre-update account: nothing of its folder exists yet.
    const fresh = join(f.a, 'claude-profiles', 'id', 'home')
    writeFileSync(f.pointer, fresh)
    const result = f.run(shell)
    expect(result.stdout).toBe(`HOME=${fresh} KEY=fake TWIN=${fresh}\n`)
    expect(result.status).toBe(23)
    expect(existsSync(fresh)).toBe(true)
    // Same mode as Orca's own setup: the folder will hold a login.
    expect(statSync(fresh).mode & 0o777).toBe(0o700)
  })

  it('still runs Claude only in the selected folder when that folder cannot be created', () => {
    const f = fixture()
    const blocked = join(f.a, 'file', 'home')
    writeFileSync(join(f.a, 'file'), '')
    writeFileSync(f.pointer, blocked)
    expect(f.run(shell).stdout).toBe(`HOME=${blocked} KEY=fake TWIN=${blocked}\n`)
  })

  it('runs nothing for a pointer that names no absolute folder', () => {
    const f = fixture()
    writeFileSync(f.pointer, 'not-a-folder')
    const result = f.run(shell)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(existsSync(join(f.a, '..', 'not-a-folder'))).toBe(false)
  })

  it('lets the user’s own CLAUDE_CONFIG_DIR win silently when an account is selected', () => {
    const f = fixture()
    const own = f.run(shell, ['CLAUDE_CONFIG_DIR=/user/own'])
    expect(own.stdout).toBe('HOME=/user/own KEY=fake TWIN=none\n')
    expect(own.stderr).toBe('')
    writeFileSync(f.pointer, f.a)
    const overridden = f.run(shell, ['CLAUDE_CONFIG_DIR=/user/own'])
    expect(overridden.stdout).toBe('HOME=/user/own KEY=fake TWIN=none\n')
    expect(overridden.stderr).toBe('')
  })
})

it("leaves the shell's Anthropic auth alone in the PowerShell function", () => {
  const script = getPowerShellClaudeShellFunction()
  expect(script).toContain("$names = @('CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_INJECTED_CONFIG_DIR')")
  expect(script).not.toMatch(/ANTHROPIC|CLAUDE_CODE_OAUTH_TOKEN|AWS_BEARER_TOKEN_BEDROCK/)
})

it('restores PowerShell process env without creating empty variables', () => {
  const script = getPowerShellClaudeShellFunction()
  expect(script.startsWith('\n$orcaClaudeCommand = Get-Command claude')).toBe(true)
  expect(script).toContain('finally {')
  // .NET 9+ turns a $null/'' SetEnvironmentVariable into an empty variable, not a removal.
  expect(script).not.toMatch(/SetEnvironmentVariable\([^)]*,\s*(\$null|''|"")\s*,/)
})

it('prints no Orca text from the PowerShell function and creates a missing account folder', () => {
  const script = getPowerShellClaudeShellFunction()
  expect(script).not.toMatch(/Write-(Host|Output|Warning)|\bthrow\b|Orca:/)
  // The shell's or Claude's own failure (claude missing, a throwing claude.ps1) still surfaces.
  expect(script.match(/Write-Error/g)).toHaveLength(1)
  expect(script).toContain(
    '} catch { $global:LASTEXITCODE = 1; Write-Error $_ -ErrorAction Continue }'
  )
  expect(script).toContain(
    'if (-not [IO.Directory]::Exists($orcaClaudeHome)) { $null = New-Item -ItemType Directory -Path $orcaClaudeHome -Force -ErrorAction SilentlyContinue }'
  )
  expect(script).toContain('-not [IO.Path]::IsPathRooted($orcaClaudeHome)')
})

it('trims the PowerShell pointer read as POSIX command substitution does', () => {
  expect(getPowerShellClaudeShellFunction()).toContain(
    '[IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER).TrimEnd()'
  )
})

it('restores the user’s own value on PowerShell System default rather than removing it', () => {
  const script = getPowerShellClaudeShellFunction()
  expect(script).toContain(
    'if ($env:CLAUDE_CONFIG_DIR -and $env:ORCA_CLAUDE_USER_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR = $env:ORCA_CLAUDE_USER_CONFIG_DIR }'
  )
  expect(script).not.toContain(
    'Remove-Item Env:CLAUDE_CONFIG_DIR, Env:ORCA_CLAUDE_INJECTED_CONFIG_DIR'
  )
})
