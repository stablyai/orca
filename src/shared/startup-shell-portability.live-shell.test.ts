/** Real-shell byte round trips validate one POSIX startup string across sh/bash/zsh/dash/fish.
 * Regression cases retain fish backslashes/apostrophes and zsh builtin eval, which command eval cannot run. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fishRequirementViolation, resolveFishBinary } from './fish-binary-requirement'
import { clearEnvCommand, quoteStartupArg, withoutEnvCommand } from './tui-agent-startup-shell'

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

const QUOTING_CASES: readonly string[] = [
  'plain',
  '',
  'with space',
  "it's",
  'a\\b',
  '\\d+',
  '\\\\server\\share',
  'C:\\Users\\foo',
  'ends\\',
  '\\',
  '$HOME',
  '`whoami`',
  '$(whoami)',
  '${HOME}',
  '(paren)',
  '{a,b}',
  '*glob?',
  '[bracket]',
  '#hash',
  'a\nb',
  'a\tb',
  'semi;colon',
  'pipe|and&',
  'redirect>out<in',
  'mixed"double\'single',
  'ünïcode-🐟',
  '-'
]

afterAll(() => {
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

// Windows has no discovered POSIX shells; skip instead of failing on missing tools.
describe.skipIf(process.platform === 'win32')(
  'one POSIX startup dialect is correct in every Unix shell',
  () => {
    // Keep CI’s required-fish check active even if shell cases skip.
    it('has the fish this suite needs when CI requires one', () => {
      expect(fishRequirementViolation(FISH)).toBeNull()
    })

    it('found shells to test against', () => {
      expect(SHELLS.map((shell) => shell.name)).toContain('sh')
    })

    describe.each(SHELLS)('$name', (shell) => {
      it.each(QUOTING_CASES)('quotes %j so the shell yields it back verbatim', (value) => {
        expect(runInShell(shell, `printf '%s' ${quoteStartupArg(value, 'posix')}`)).toBe(value)
      })

      it('quotes a whole argv so every argument survives independently', () => {
        const argv = QUOTING_CASES.filter((value) => value !== '')
        const quoted = argv.map((value) => quoteStartupArg(value, 'posix')).join(' ')
        // NUL cannot occur inside these argv fixtures, so accidental argument splits remain detectable.
        const output = runInShell(shell, `printf '%s\\0' ${quoted}`)
        expect(output.split('\0').slice(0, -1)).toEqual(argv)
      })

      // The copied resume clears env before launching; a set -u abort here loses the agent (#14863/#14975).
      it('runs the agent under set -u, with the vars removed', () => {
        // Read env in the child, not the caller, to verify what the agent inherits.
        const launch = withoutEnvCommand(
          ['CODEX_HOME', 'ORCA_CODEX_HOME'],
          `sh -c 'printf "LAUNCHED:%s" "\${CODEX_HOME-unset}"'`,
          'posix'
        )
        const probe =
          shell.name === 'fish'
            ? `set -gx CODEX_HOME /bad; ${launch}`
            : `set -u; CODEX_HOME=/bad; export CODEX_HOME; ${launch}`

        expect(runInShell(shell, probe)).toContain('LAUNCHED:unset')
      })

      it('clears an exported variable with no wrapper installed', () => {
        const clear = clearEnvCommand('ORCA_PI_PREFILL', 'posix')
        const probe =
          shell.name === 'fish'
            ? `set -gx ORCA_PI_PREFILL draft; ${clear}; set -q ORCA_PI_PREFILL; and echo STILL; or echo CLEARED`
            : `ORCA_PI_PREFILL=draft; export ORCA_PI_PREFILL; ${clear}; echo "\${ORCA_PI_PREFILL:+STILL}\${ORCA_PI_PREFILL:-CLEARED}"`
        expect(runInShell(shell, probe).trim()).toBe('CLEARED')
      })

      it('clears several variables in one statement', () => {
        const clear = clearEnvCommand(['ORCA_A', 'ORCA_B'], 'posix')
        const probe =
          shell.name === 'fish'
            ? `set -gx ORCA_A 1; set -gx ORCA_B 2; ${clear}; set -q ORCA_A; or set -q ORCA_B; and echo STILL; or echo CLEARED`
            : `ORCA_A=1 ORCA_B=2; export ORCA_A ORCA_B; ${clear}; echo "\${ORCA_A:+STILL}\${ORCA_B:+STILL}\${ORCA_A:-CLEARED}"`
        expect(runInShell(shell, probe).trim()).toBe('CLEARED')
      })

      // Fish erase returns nonzero for absent names; A && B || C would then run sh’s unset and fail.
      it.each([
        ['already set', true],
        ['already unset', false]
      ])('exits 0 and writes nothing to stderr when the variable is %s', (_label, preset) => {
        const clear = clearEnvCommand('ORCA_PI_PREFILL', 'posix')
        const setUp = preset
          ? shell.name === 'fish'
            ? 'set -gx ORCA_PI_PREFILL draft; '
            : 'ORCA_PI_PREFILL=draft; export ORCA_PI_PREFILL; '
          : ''
        const stderr = execFileSync(shell.path, ['-c', `${setUp}${clear} 2>&1 1>/dev/null`], {
          encoding: 'utf8',
          timeout: 20_000,
          env: sandboxEnv()
        })
        expect(stderr).toBe('')
      })

      // Only interactive shells expand aliases; a -c test misses alias test preventing env cleanup.
      it.runIf(['bash', 'zsh'].includes(shell.name))(
        'clears even when `test` is aliased away in an interactive shell',
        () => {
          const clear = clearEnvCommand('ORCA_PI_PREFILL', 'posix')
          const script = [
            'alias test=false',
            'ORCA_PI_PREFILL=draft; export ORCA_PI_PREFILL',
            clear,
            'echo "RESULT=${ORCA_PI_PREFILL:+STILL}${ORCA_PI_PREFILL:-CLEARED}"'
          ].join('\n')
          const out = execFileSync(shell.path, ['-i'], {
            input: `${script}\n`,
            encoding: 'utf8',
            timeout: 20_000,
            env: sandboxEnv(),
            stdio: ['pipe', 'pipe', 'ignore']
          })
          expect(out).toContain('RESULT=CLEARED')
        }
      )

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

      it.runIf(['bash', 'zsh'].includes(shell.name))(
        'never enables errexit when $fish_pid misfires',
        () => {
          const clear = clearEnvCommand('ORCA_PI_PREFILL', 'posix')
          const probe = `fish_pid=1; export fish_pid; ${clear} 2>/dev/null; printf '%s' "$-"`
          expect(runInShell(shell, probe).trim()).not.toContain('e')
        }
      )
    })
  }
)
