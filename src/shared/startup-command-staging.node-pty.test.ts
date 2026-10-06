/**
 * Real shells in real PTYs: the line a host types for a long or multi-line launch
 * must reach the agent's argv byte for byte, run it as its own foreground job as a
 * typed line would, and leave no script behind.
 *
 * The line is written the moment the shell spawns, while the TTY is still in
 * canonical mode — the window where a typed line past MAX_CANON is truncated
 * and a raw newline submits early.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveFishBinary } from './fish-binary-requirement'
import { stageStartupCommand } from './startup-command-staging'
import { buildStartupCommandSubmission } from './startup-command-submission'
import { quoteStartupArg } from './tui-agent-startup-shell'

type LiveShell = { name: string; path: string; args: string[] }

function discoverShells(): LiveShell[] {
  if (process.platform === 'win32') {
    return []
  }
  const shells: LiveShell[] = []
  const add = (name: string, path: string, args: string[]): void => {
    if (existsSync(path) && !shells.some((shell) => shell.name === name)) {
      shells.push({ name, path, args })
    }
  }
  add('bash', '/bin/bash', ['--noprofile', '--norc', '-i'])
  add('zsh', '/bin/zsh', ['-f', '-i'])
  add('dash', '/bin/dash', ['-i'])
  add('dash', '/usr/bin/dash', ['-i'])
  add('sh', '/bin/sh', ['-i'])
  add('ksh', '/bin/ksh', ['-i'])
  // Why tcsh: no staging shell; its line runs the POSIX script through /bin/sh.
  add('tcsh', '/bin/tcsh', ['-f', '-i'])
  const fish = resolveFishBinary(3)
  if (fish.available) {
    // Why absolute: the sandbox PATH would not resolve a bare `fish`.
    const fishPath = fish.path.includes('/')
      ? fish.path
      : execFileSync('/bin/sh', ['-c', `command -v ${fish.path}`], { encoding: 'utf8' }).trim()
    add('fish', fishPath, ['--no-config', '-i'])
  }
  return shells
}

const SANDBOX = mkdtempSync(join(tmpdir(), 'orca-staging-pty-'))
const AGENT = join(SANDBOX, 'agent')
writeFileSync(
  AGENT,
  `#!/bin/sh\nps -o pgid=,tpgid= -p $$ > "$ORCA_TEST_CAPTURE.job"\nfor arg in "$@"; do printf '%s\\0' "$arg"; done > "$ORCA_TEST_CAPTURE"\n`
)
chmodSync(AGENT, 0o755)

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

const HOSTILE = `it's "quoted" $HOME \`id\` $(id) \\\\server\\share %PATH% !! #`

const PROMPTS: [string, string][] = [
  ['a 600-byte prompt', `${HOSTILE} ${'x'.repeat(600)}`],
  // Why 5 KB: past Linux's 4096-byte canonical buffer as well as macOS's 1024.
  ['a 5 KB prompt', `${HOSTILE} ${'y'.repeat(5000)}`],
  ['a multi-line prompt with a trailing newline', `first line\n${HOSTILE}\n\nlast line\n`],
  // Why: typed raw, a line editor reads the TAB as completion and mangles the argument.
  ['a prompt with a tab', 'before\tafter']
]

type AgentRun = { argv: string; pgid: number; foregroundPgid: number; shellPid: number }

async function launchInRealShell(shell: LiveShell, prompt: string): Promise<AgentRun | null> {
  const caseDir = mkdtempSync(join(SANDBOX, `${shell.name}-`))
  const capture = join(caseDir, 'argv')
  const command = `${quoteStartupArg(AGENT, 'posix')} ${quoteStartupArg(prompt, 'posix')}`
  const staging = stageStartupCommand({
    command,
    shellPath: shell.path,
    orcaBuiltLine: true,
    directory: caseDir
  })
  const proc = pty.spawn(shell.path, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: caseDir,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: caseDir,
      TERM: 'xterm-256color',
      XDG_CONFIG_HOME: join(caseDir, 'config'),
      XDG_DATA_HOME: join(caseDir, 'data'),
      ORCA_TEST_CAPTURE: capture
    }
  })
  const typeLine = (): void =>
    proc.write(buildStartupCommandSubmission(staging.command, { bracketedPasteSafe: false }))
  // Why fish differs: it blocks on terminal queries and drops input typed before its prompt, which
  // is why hosts wait for its ready marker; the other shells get the harsher at-spawn write.
  let typed = false
  const onData = proc.onData((data) => {
    if (shell.name !== 'fish') {
      return
    }
    proc.write('\x1b[?62;22c'.repeat(data.split('\x1b[0c').length - 1))
    proc.write('\x1b[1;1R'.repeat(data.split('\x1b[6n').length - 1))
    if (!typed && data.includes('\x1b]133;A')) {
      typed = true
      typeLine()
    }
  })
  try {
    if (shell.name !== 'fish') {
      typeLine()
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (existsSync(capture)) {
        // Why a beat: the agent's redirect creates the file before printf fills it.
        await new Promise((resolve) => setTimeout(resolve, 100))
        const [pgid, foregroundPgid] = readFileSync(`${capture}.job`, 'utf8').trim().split(/\s+/)
        return {
          argv: readFileSync(capture, 'utf8'),
          pgid: Number(pgid),
          foregroundPgid: Number(foregroundPgid),
          shellPid: proc.pid
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return null
  } finally {
    onData.dispose()
    proc.kill()
    expect(readdirSync(caseDir).filter((name) => name.startsWith('orca-launch-'))).toEqual([])
  }
}

const SHELLS = discoverShells()
const describeShells = SHELLS.length > 0 ? describe : describe.skip

describeShells('a staged launch line in a real shell', () => {
  for (const shell of SHELLS) {
    it.each(PROMPTS)(
      `reaches the agent byte for byte, as its own job, in ${shell.name}: %s`,
      async (_, prompt) => {
        const run = await launchInRealShell(shell, prompt)
        expect(run?.argv).toBe(`${prompt}\0`)
        // Why: in the shell's own group, Ctrl-Z never stops the agent and the shell-in-front check
        // cannot tell the two apart.
        expect(run?.pgid).not.toBe(run?.shellPid)
        expect(run?.pgid).toBe(run?.foregroundPgid)
      },
      20_000
    )
  }
})
