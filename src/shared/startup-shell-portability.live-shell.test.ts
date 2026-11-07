/** Real-shell byte round trips validate one POSIX startup string across sh/bash/zsh/dash/fish.
 * Regression cases retain fish backslashes/apostrophes and zsh builtin eval, which command eval cannot run. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveFishBinary } from './fish-binary-requirement'
import { clearEnvCommand } from './agent-launch/startup/tui-agent-startup-shell'

const FISH = resolveFishBinary(4)

type LiveShell = { name: string; path: string }

function discoverShells(): LiveShell[] {
  const shells: LiveShell[] = []
  for (const path of [
    '/bin/sh',
    '/bin/bash',
    '/bin/zsh',
    '/bin/dash',
    '/usr/bin/dash',
    '/bin/ksh'
  ]) {
    if (existsSync(path) && !shells.some((shell) => shell.name === basename(path))) {
      shells.push({ name: basename(path), path })
    }
  }
  if (FISH.available) {
    // Sandbox PATH cannot resolve bare fish.
    const path = FISH.path.includes('/')
      ? FISH.path
      : execFileSync('command', ['-v', FISH.path], { encoding: 'utf8', shell: true }).trim()
    shells.push({ name: 'fish', path })
  }
  return shells
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

// Fish needs a writable HOME for universal variables or every launch warns.
const SANDBOX_HOME = mkdtempSync(path.join(tmpdir(), 'orca-shell-portability-'))

function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: SANDBOX_HOME,
    XDG_CONFIG_HOME: path.join(SANDBOX_HOME, 'config'),
    XDG_DATA_HOME: path.join(SANDBOX_HOME, 'data')
  }
}

function runInShell(shell: LiveShell, script: string): string {
  return execFileSync(shell.path, ['-c', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: sandboxEnv()
  })
}

const SHELLS = discoverShells()

afterAll(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

// Windows has no discovered POSIX shells; skip instead of failing on missing tools.
describe.skipIf(process.platform === 'win32')(
  'one POSIX startup dialect is correct in every Unix shell',
  () => {
    describe.each(SHELLS)('$name', (shell) => {
      // Keep -g: erasing a lone universal would permanently change future fish sessions, including clipboard launches without injected env.
      it.runIf(shell.name === 'fish')('never deletes a lone universal variable', () => {
        const clear = clearEnvCommand('ORCA_PI_PREFILL', 'posix')
        const probe = `set -Ux ORCA_PI_PREFILL persisted; ${clear}; set -q ORCA_PI_PREFILL; and echo "RESULT=$ORCA_PI_PREFILL"; or echo RESULT=DESTROYED; set -Ue ORCA_PI_PREFILL`
        expect(runInShell(shell, probe)).toContain('RESULT=persisted')
      })

      // Erase the injected global so the user’s shadowed universal reappears.
      it.runIf(shell.name === 'fish')('reveals a shadowed universal instead of deleting it', () => {
        const clear = clearEnvCommand('ORCA_PI_PREFILL', 'posix')
        const probe = `set -Ux ORCA_PI_PREFILL mine; set -gx ORCA_PI_PREFILL injected; ${clear}; echo "RESULT=$ORCA_PI_PREFILL"; set -Ue ORCA_PI_PREFILL`
        expect(runInShell(shell, probe)).toContain('RESULT=mine')
      })
    })
  }
)
