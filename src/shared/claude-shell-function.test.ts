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
import { agentSessionSignInCommand } from './agent-session/lifecycle/agent-session-setup-commands'
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
  const bin = join(root, 'bin')
  for (const dir of [a, bin]) {
    mkdirSync(dir)
  }
  const fake = join(bin, 'claude')
  writeFileSync(
    fake,
    '#!/bin/sh\nprintf "HOME=%s KEY=%s TWIN=%s\\n" "${CLAUDE_CONFIG_DIR-default}" "${ANTHROPIC_API_KEY-none}" "${ORCA_CLAUDE_INJECTED_CONFIG_DIR-none}"\nexit 23\n'
  )
  chmodSync(fake, 0o700)
  const pointer = join(root, 'selected')
  const run = (
    shell: string,
    env: string[] = [],
    fakeKind: 'summary' | 'direct' = 'summary',
    userSetup = '',
    command = 'claude'
  ) => {
    if (fakeKind === 'direct') {
      // A subshell left between the pane shell and Claude leads Claude's foreground group.
      writeFileSync(fake, '#!/bin/sh\n[ "$PPID" = "$PANE_SHELL_PID" ] && echo direct\n')
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
        `${guard}\n${userSetup}\n${fn}\n${command}`
      ],
      { encoding: 'utf8', cwd: root }
    )
    expect(result.status).not.toBe(97)
    expect(result.stderr).toBe('')
    return result
  }
  return { a, pointer, run }
}
const injected = (home: string) => [
  `CLAUDE_CONFIG_DIR=${home}`,
  `ORCA_CLAUDE_INJECTED_CONFIG_DIR=${home}`
]

describe.each(SHELLS)('the claude function in %s', (shell) => {
  it('signs the system account in while a managed profile is selected, preserving later routing', () => {
    const f = fixture()
    writeFileSync(f.pointer, f.a)
    const command = agentSessionSignInCommand('claude', { account: 'system', remote: false })
    const env = [...injected(f.a), 'ORCA_CLAUDE_USER_CONFIG_DIR=/user/system account/']
    const result = f.run(shell, env, 'summary', '', `${command}; claude`)
    expect(result.stdout).toBe(
      `HOME=/user/system account/ KEY=fake TWIN=none\nHOME=${f.a} KEY=fake TWIN=${f.a}\n`
    )
    expect(result.status).toBe(23)
    expect(f.run(shell, injected(f.a), 'summary', '', command!).stdout).toBe(
      'HOME=default KEY=fake TWIN=none\n'
    )
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

  it.skipIf(!POSIX_SHELLS.includes(shell))(
    'keeps the user’s own claude function when the cwd has a claude entry',
    () => {
      const f = fixture()
      writeFileSync(f.pointer, f.a)
      mkdirSync(join(f.a, '..', 'claude'))
      const userFn = 'claude() { echo user function; }'
      expect(f.run(shell, [], 'summary', userFn).stdout).toBe('user function\n')
    }
  )

  it.skipIf(shell.endsWith('fish'))(
    'replaces the subshell so Claude is a direct child of the pane shell',
    () => {
      const f = fixture()
      const own = 'ORCA_CLAUDE_USER_CONFIG_DIR=/user/own'
      const setup = 'export PANE_SHELL_PID=$$'
      writeFileSync(f.pointer, f.a)
      expect(f.run(shell, [], 'direct', setup).stdout).toBe('direct\n')
      writeFileSync(f.pointer, '')
      expect(f.run(shell, [...injected(f.a), own], 'direct', setup).stdout).toBe('direct\n')
      expect(f.run(shell, [], 'direct', setup).stdout).toBe('direct\n')
    }
  )
})
