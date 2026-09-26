/**
 * #23250 proven against a real line editor instead of a string comparison.
 *
 * The byte-level tests pin the constant; they cannot say whether the constant is
 * right. This can. A shell whose `^J` does not accept the line — a vi-mode `.zshrc`
 * in zsh, a `"\C-j"` binding in readline — is measured here doing the wrong thing
 * with an LF and the right thing with the CR the builder now emits, in the same run.
 * Why CR is the only byte that can be right on every platform: while zle or readline
 * owns the terminal the tty is in raw mode, so ICRNL is off and a newline arrives as
 * `^J`, a keystroke the user's keymap may answer with anything; Enter sends CR, which
 * submits in both a raw-mode line editor and a canonical-mode tty.
 *
 * Each shell starts with only this file's own rc reachable, so a host profile cannot
 * rebind the key or replace the prompt the readiness sentinel lives in.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { buildStartupCommandSubmission } from './startup-command-submission'

const hasZsh = process.platform !== 'win32' && spawnSync('/bin/zsh', ['--version']).status === 0
const hasBash = process.platform !== 'win32' && spawnSync('/bin/bash', ['--version']).status === 0

/** Rendered verbatim; zsh prompt escapes are avoided so matching cannot drift. */
const SENTINEL = 'ORCA-SUBMIT-BYTE-PROMPT>'
/** Written by the startup command, and matched in the tty echo to prove it was typed. */
const RAN_FILE = 'orca-submit-byte-ran'

type ShellFixture = {
  name: string
  path: string
  args: (home: string) => string[]
  env: (home: string) => Record<string, string>
  files: Record<string, string>
  available: boolean
}

const FIXTURES: ShellFixture[] = [
  {
    name: 'zsh',
    path: '/bin/zsh',
    args: () => ['-o', 'noglobalrcs', '-l', '-i'],
    env: (home) => ({ HOME: home, ZDOTDIR: home }),
    // Why vi-mode: it is the shape of a real user's request (`bindkey -v` plus an
    // explicit `^J`), and it is the only way to get a shell in which LF is not a
    // submit byte — precisely the case the platform branch could not see.
    files: {
      '.zshrc': `
bindkey -v
orca_insert_newline() { LBUFFER+=$'\\n' }
zle -N orca_insert_newline
bindkey -M viins '^J' orca_insert_newline
PROMPT='${SENTINEL} '
RPROMPT=''
`
    },
    available: hasZsh
  },
  {
    name: 'bash',
    path: '/bin/bash',
    // Why not `-l`: a login Bash reads /etc/profile and the host's own profile, which
    // is exactly the config that could rebind the key. `--rcfile` replaces the user's
    // `.bashrc`, and macOS still ships Bash 3.2, which has no `--no-global-rc`.
    args: (home) => ['--rcfile', join(home, '.bashrc'), '-i'],
    env: (home) => ({ HOME: home, INPUTRC: join(home, 'inputrc') }),
    // Why `quoted-insert`: readline's spelling of the zle widget above — `^J` puts a
    // literal newline in the buffer instead of running the line.
    files: {
      inputrc: '$if Bash\nset editing-mode emacs\n"\\C-j": "\\C-v\\C-j"\n$endif\n',
      '.bashrc': `PS1='${SENTINEL} '\n`
    },
    available: hasBash
  }
]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
    }
    await delay(20)
  }
}

type LiveShell = {
  /** The startup command under test: creates `ranFile` when the line is submitted. */
  command: string
  write: (data: string) => void
  output: () => string
  /** Resolves once the tty has been silent for `quietMs` — a settling prompt, not a sleep. */
  settle: (quietMs?: number) => Promise<void>
  ran: () => boolean
  dispose: () => void
}

async function startShell(fixture: ShellFixture): Promise<LiveShell> {
  const home = mkdtempSync(join(tmpdir(), 'orca-submit-byte-'))
  const ranFile = join(home, RAN_FILE)
  for (const [name, content] of Object.entries(fixture.files)) {
    writeFileSync(join(home, name), content)
  }
  const proc = pty.spawn(fixture.path, fixture.args(home), {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    cwd: home,
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', ...fixture.env(home) }
  })
  let output = ''
  let lastDataAt = Date.now()
  proc.onData((chunk) => {
    output += chunk
    lastDataAt = Date.now()
  })
  return {
    // Why the command writes a file: a PTY echoes the line being typed, so tty output
    // matches the echo of a command as readily as its result. Only the file says it ran.
    command: `: > ${JSON.stringify(ranFile)}`,
    write: (data) => proc.write(data),
    output: () => output,
    settle: async (quietMs = 250) => {
      let idle = Date.now() - lastDataAt
      while (idle < quietMs) {
        await delay(quietMs - idle)
        idle = Date.now() - lastDataAt
      }
    },
    ran: () => existsSync(ranFile),
    dispose: () => {
      // Why leave the directory first: the shell holds it as its cwd and writes its
      // history there as it exits, which is what makes removal fail with ENOTEMPTY.
      proc.write('cd /\rexit\r')
      try {
        proc.kill()
      } catch {
        // Already exited.
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    }
  }
}

describe.skipIf(process.platform === 'win32')('submit byte in a live line editor', () => {
  for (const fixture of FIXTURES) {
    const shellTest = fixture.available ? it : it.skip

    // The bug's own shape, measured rather than asserted: `^J` belongs to the keymap,
    // so an LF-terminated command is typed and then waits. Without this leg the CR test
    // below passes for any shell, and cannot regress.
    shellTest(
      `${fixture.name} leaves an LF-terminated command at the prompt`,
      async () => {
        const shell = await startShell(fixture)
        try {
          await waitFor(() => shell.output().includes(SENTINEL), `${fixture.name} prompt`)
          await shell.settle()
          shell.write(
            buildStartupCommandSubmission(shell.command, {
              submit: '\n',
              bracketedPasteSafe: false
            })
          )
          await waitFor(() => shell.output().includes(RAN_FILE), 'the line to be typed')
          await shell.settle(600)
          expect(shell.ran()).toBe(false)

          // Enter is what rescues it, so the line really is sitting in the buffer intact
          // rather than having been dropped or split.
          shell.write('\r')
          await waitFor(shell.ran, `${fixture.name} to run the held line on Enter`)
        } finally {
          shell.dispose()
        }
      },
      45_000
    )

    shellTest(
      `${fixture.name} runs the command the builder submits by default`,
      async () => {
        const shell = await startShell(fixture)
        try {
          await waitFor(() => shell.output().includes(SENTINEL), `${fixture.name} prompt`)
          await shell.settle()
          shell.write(buildStartupCommandSubmission(shell.command, { bracketedPasteSafe: false }))
          await waitFor(shell.ran, `${fixture.name} to run it with no second keystroke`)
        } finally {
          shell.dispose()
        }
      },
      45_000
    )
  }
})
