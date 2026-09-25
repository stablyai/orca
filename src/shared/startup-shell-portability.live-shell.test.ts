/**
 * Proves the central claim of the POSIX startup dialect against real shells:
 * ONE emitted string is correct in sh, bash, zsh, dash and fish alike, so Orca
 * never has to detect which shell will parse a queued command line.
 *
 * The shells are the oracle. Each case is handed to a real shell, which echoes
 * the value back through `printf`, and the test compares bytes — a hand-written
 * expectation would only re-state the implementation's own assumptions.
 *
 * Two of the quoting cases are regression pins with teeth: `\\server\share` and
 * a trailing backslash are exactly what plain sh `'\''` quoting gets wrong when
 * fish reads it (silently dropped backslashes, and a hard syntax error), and
 * `command eval` is what zsh gets wrong — its `command` resolves external
 * binaries only, so it cannot run a builtin.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fishRequirementViolation, resolveFishBinary } from './fish-binary-requirement'
import { clearEnvCommand, quoteStartupArg, withoutEnvCommand } from './tui-agent-startup-shell'

const FISH = resolveFishBinary(4)

type LiveShell = { name: string; path: string }

/** Every Unix shell on this machine a queued Orca command line could land in. */
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
    // Why absolute: runInShell scrubs PATH, so a bare `fish` would not resolve.
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

// Why a real (empty) HOME rather than a bogus one: fish needs a writable config
// dir to hold universal variables, and warns loudly on every launch without it.
const SANDBOX_HOME = mkdtempSync(path.join(tmpdir(), 'orca-shell-portability-'))

/** Env with no user shell config reachable, so only Orca's own text is exercised. */
function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: SANDBOX_HOME,
    XDG_CONFIG_HOME: path.join(SANDBOX_HOME, 'config'),
    XDG_DATA_HOME: path.join(SANDBOX_HOME, 'data')
  }
}

/** Runs one line in a real shell with no user config reachable. */
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

// Why skipIf: on Windows discoverShells() finds nothing, so the suite would
// fail for want of a POSIX shell rather than for any defect it tests.
describe.skipIf(process.platform === 'win32')(
  'one POSIX startup dialect is correct in every Unix shell',
  () => {
    // Always runs, so a CI lane cannot report green with the shell cases skipped.
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
        // Why NUL: it is the one byte no case above can contain, so it cannot be
        // forged by a value that was mis-split into two arguments.
        const output = runInShell(shell, `printf '%s\\0' ${quoted}`)
        expect(output.split('\0').slice(0, -1)).toEqual(argv)
      })

      // Why `set -u` gets its own case: the copied resume command puts the clear
      // BEFORE the agent, so an aborted line takes the launch down with it. That
      // is the regression that reverted #14863 (#14975).
      it('runs the agent under set -u, with the vars removed', () => {
        // The child must read its own environment, the way the agent binary does;
        // expanding it in the caller would just echo the caller's value back.
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

      // Why this case: fish's `set -e` returns non-zero for a variable that is
      // already unset. An `A && B || C` spelling would fall through to the sh
      // branch and print `Unknown command: unset` — the exact bug being fixed.
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

      // Why INTERACTIVE (-i, script on stdin): aliases are only expanded by an
      // interactive shell, which is the mode Orca types into — a `-c` run cannot
      // see this class of bug at all. A user with `alias test=…` would otherwise
      // silently skip both branches and keep the prefill exported.
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

      // Why: `$fish_pid` is a heuristic — any non-empty value takes the fish
      // branch. `set -e NAME` there would enable errexit, silently changing the
      // semantics of every command after it for the rest of the session.
      // `set --erase` cannot: `--` ends option parsing, so the worst a misfire
      // costs is a usage message and the positional parameters (which an
      // interactive shell does not meaningfully use).
      // Scoped to bash/zsh because `set` is a POSIX special builtin: in sh, dash
      // and ksh a misfire aborts a NON-interactive shell before anything can be
      // observed. Interactively — the mode Orca types into — they survive without
      // errexit too, but that is not scriptable here. bash and zsh report `$-`
      // either way, and both DID silently enable errexit under the old `set -e`.
      // Why `-g` is not optional: without it, a name that exists ONLY as a
      // universal — `set -Ux CODEX_HOME …`, a normal thing for a fish user to
      // have — is permanently deleted from every future session. Reachable from
      // the clipboard command, which may run with no injected value at all.
      it.runIf(shell.name === 'fish')('never deletes a lone universal variable', () => {
        const clear = clearEnvCommand('ORCA_PI_PREFILL', 'posix')
        const probe = `set -Ux ORCA_PI_PREFILL persisted; ${clear}; set -q ORCA_PI_PREFILL; and echo "RESULT=$ORCA_PI_PREFILL"; or echo RESULT=DESTROYED; set -Ue ORCA_PI_PREFILL`
        expect(runInShell(shell, probe)).toContain('RESULT=persisted')
      })

      // A universal shadowed by the injected global: the global goes, theirs
      // comes back. That is the wanted outcome, not a missed erase.
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
