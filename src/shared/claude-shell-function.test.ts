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
import { getPosixClaudeShellFunction, getFishClaudeShellFunction } from './claude-shell-function'
// Skip missing zsh/fish instead of failing with exit 127 on CI images.
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
    // Abort if system config shadows the fake with a real claude binary.
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

  it('restores the user’s own value Orca replaced when switched back to System default', () => {
    const f = fixture()
    const own = ['ORCA_CLAUDE_USER_CONFIG_DIR=/user/own']
    writeFileSync(f.pointer, f.a)
    const account = f.run(shell, [...injected(f.a), ...own])
    expect(account.stdout).toBe(`HOME=${f.a} KEY=fake TWIN=${f.a}\n`)
    writeFileSync(f.pointer, '')
    const restored = f.run(shell, [...injected(f.a), ...own])
    expect(restored.stdout).toBe('HOME=/user/own KEY=fake TWIN=none\n')
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
    const fresh = join(f.a, 'claude-profiles', 'id', 'home')
    writeFileSync(f.pointer, fresh)
    const result = f.run(shell)
    expect(result.stdout).toBe(`HOME=${fresh} KEY=fake TWIN=${fresh}\n`)
    expect(result.status).toBe(23)
    expect(existsSync(fresh)).toBe(true)
    // Match private login-folder permissions.
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

  it('follows the selection over the user’s own CLAUDE_CONFIG_DIR, inherited or exported by an rc', () => {
    const f = fixture()
    // Why the slash: Claude keys its login by the exact string, so System default keeps the spelling.
    const own = ['CLAUDE_CONFIG_DIR=/user/own/', 'ORCA_CLAUDE_USER_CONFIG_DIR=/user/own/']
    writeFileSync(f.pointer, f.a)
    expect(f.run(shell, own).stdout).toBe(`HOME=${f.a} KEY=fake TWIN=${f.a}\n`)
    const rc = [...own, `ORCA_CLAUDE_INJECTED_CONFIG_DIR=${f.b}`]
    expect(f.run(shell, rc).stdout).toBe(`HOME=${f.a} KEY=fake TWIN=${f.a}\n`)
    writeFileSync(f.pointer, '')
    expect(f.run(shell, own).stdout).toBe('HOME=/user/own/ KEY=fake TWIN=none\n')
    writeFileSync(f.pointer, f.a)
    expect(
      f.run(shell, ['CLAUDE_CONFIG_DIR=/user/own', 'ORCA_CLAUDE_USER_CONFIG_DIR=/user/own/']).stdout
    ).toBe(`HOME=${f.a} KEY=fake TWIN=${f.a}\n`)
    const deliberate = [
      'CLAUDE_CONFIG_DIR=/somewhere/else',
      'ORCA_CLAUDE_USER_CONFIG_DIR=/user/own'
    ]
    writeFileSync(f.pointer, f.a)
    expect(f.run(shell, deliberate).stdout).toBe('HOME=/somewhere/else KEY=fake TWIN=none\n')
  })
})
