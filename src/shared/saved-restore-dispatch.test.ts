import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFishClaudeShellFunction, getPosixClaudeShellFunction } from './claude-shell-function'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight
} from './codex-shell-function'
import {
  FISH_SAVED_RESTORE_CAPTURE,
  FISH_SAVED_RESTORE_INSTALL,
  getSavedRestoreActionFiles,
  POSIX_SAVED_RESTORE_CAPTURE,
  POSIX_SAVED_RESTORE_INSTALL,
  SAVED_RESTORE_ACTION_ENV,
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_ORIGINAL_ENV,
  SAVED_RESTORE_SCRIPT_ENV
} from './saved-restore-dispatch'
import { getFishSavedRestoreScript, getPosixSavedRestoreScript } from './saved-restore-scripts'

// The production pieces a root shell runs, in its real order: capture before startup files, the
// user's own startup file, Orca's agent functions (recording their definitions), the installer,
// then the one-shot startup action its first prompt runs. A stand-in CLI records each check and
// answers as main would: 75 = start fresh, anything else = resume.
const ENTRY = '0123456789abcdef'
const TOKEN = '0123456789abcdef0123456789abcdef'
const FRESH = ['--model', "a b'c", '']
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

type Shell = {
  name: string
  path: string
  args: string[]
  root: (userRc: string) => string
  start: string
  userClaude: string
  userAlias?: string
  replaceClaude: string
}
const POSIX_ROOT = (userRc: string) =>
  `${POSIX_SAVED_RESTORE_CAPTURE}\n${userRc}\n${getPosixCodexShellLaunchPreflight()}${getPosixClaudeShellFunction()}${POSIX_SAVED_RESTORE_INSTALL}`
const SHELLS: Shell[] = [
  {
    name: 'bash',
    path: '/bin/bash',
    args: ['--norc', '--noprofile', '-c'],
    root: POSIX_ROOT,
    start: '__orca_sr_prompt',
    userClaude: 'claude() { CLAUDE_CONFIG_DIR="$HOME/work" command claude --mine "$@"; }',
    userAlias: 'shopt -s expand_aliases; alias claude="command claude --aliased"',
    replaceClaude: 'claude() { command claude --replaced "$@"; }'
  },
  {
    name: 'zsh',
    path: '/bin/zsh',
    args: ['-f', '-c'],
    root: POSIX_ROOT,
    start: '__orca_sr_prompt',
    userClaude: 'claude() { CLAUDE_CONFIG_DIR="$HOME/work" command claude --mine "$@"; }',
    userAlias: 'alias claude="command claude --aliased"',
    replaceClaude: 'claude() { command claude --replaced "$@"; }'
  },
  {
    name: 'fish',
    path: '/opt/homebrew/bin/fish',
    args: ['--no-config', '-c'],
    root: (userRc) =>
      `${FISH_SAVED_RESTORE_CAPTURE}\n${userRc}\n${getFishCodexShellLaunchPreflight(true)}${getFishClaudeShellFunction(true)}\n${FISH_SAVED_RESTORE_INSTALL}`,
    start: '__orca_sr_prompt',
    // An autoloaded function file, as a user's ~/.config/fish/functions/claude.fish is.
    userClaude:
      "set -g fish_function_path $HOME/functions $fish_function_path; mkdir -p $HOME/functions; echo 'function claude; env CLAUDE_CONFIG_DIR=$HOME/work claude --mine $argv; end' > $HOME/functions/claude.fish",
    replaceClaude: 'function claude; command claude --replaced $argv; end'
  }
].filter((shell) => process.platform !== 'win32' && existsSync(shell.path))

function rig(answer: number | 'no-cli', agent = 'claude', resume = ['--resume', 'X']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-restore-start-')))
  roots.push(root)
  const log = join(root, 'check.log')
  const check = join(root, 'orca')
  writeFileSync(
    check,
    `#!/bin/sh
if [ "$3" = --phase ]; then printf 'dispatched %s %s\\n' "$6" "$8" >> "${log}"; exit 0; fi
printf 'check %s %s %s config=%s|' "$4" "$6" "$8" "\${CLAUDE_CONFIG_DIR-}" >> "${log}"
tr '\\0' '|' >> "${log}"; printf '\\n' >> "${log}"
exit ${answer === 'no-cli' ? 0 : answer}
`
  )
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const name of ['claude', 'codex', 'opencode']) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\n[ "$1" = --help ] && { echo --no-daemon; exit 0; }\nprintf '%s|' ${name} "$@"; printf 'config=%s\\n' "\${CLAUDE_CONFIG_DIR-}"\n`
    )
    chmodSync(join(bin, name), 0o755)
  }
  chmodSync(check, 0o755)
  writeFileSync(join(root, 'restore.sh'), getPosixSavedRestoreScript())
  writeFileSync(join(root, 'restore.fish'), getFishSavedRestoreScript())
  const files = getSavedRestoreActionFiles({
    entry: ENTRY,
    token: TOKEN,
    agent,
    resumeArgs: resume,
    freshArgs: FRESH
  })
  const original = `${agent} ${resume.map((arg) => `'${arg}'`).join(' ')}`
  const run = (shell: Shell, lines: string[], opts: { userRc?: string; env?: string[] } = {}) => {
    writeFileSync(join(root, 'action.sh'), files.sh)
    writeFileSync(join(root, 'action.fish'), files.fish)
    const result = spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${root}`,
        `PATH=${bin}:/usr/bin:/bin`,
        `${SAVED_RESTORE_CHECK_ENV}=${answer === 'no-cli' ? join(root, 'missing') : check}`,
        `${SAVED_RESTORE_ACTION_ENV}=${join(root, 'action')}`,
        `${SAVED_RESTORE_SCRIPT_ENV}=${join(root, 'restore')}`,
        `${SAVED_RESTORE_ORIGINAL_ENV}=${original}`,
        'ORCA_TERMINAL_HANDLE=term-1',
        ...(opts.env ?? []),
        shell.path,
        ...shell.args,
        `${shell.root(opts.userRc ?? '')}\n${lines.join('\n')}`
      ],
      { encoding: 'utf8', cwd: root }
    )
    return result.stdout.trim().split('\n')
  }
  const checks = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('check'))
      : []
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
  return { root, run, checks, logged, original }
}

describe.each(SHELLS)('a saved restore started by the $name root shell', (shell) => {
  it('shows the plain command, runs fresh once, and a recall is an ordinary resume', async () => {
    const { run, checks, logged, original } = rig(75)
    expect(run(shell, [shell.start, original, shell.start])).toEqual([
      original,
      "claude|--model|a b'c||config=",
      'claude|--resume|X|config='
    ])
    expect(checks()).toEqual([`check claude ${ENTRY} ${TOKEN} config=|--resume|X|`])
    await vi.waitFor(() => expect(logged()).toContain(`dispatched ${ENTRY} ${TOKEN}`))
  })

  it.each([1, 'no-cli'] as const)(
    'runs the original command when the check answers resume or never reaches main (%s)',
    (answer) => {
      const { run, checks, logged, original } = rig(answer)
      expect(run(shell, [shell.start, original])).toEqual([
        original,
        'claude|--resume|X|config=',
        'claude|--resume|X|config='
      ])
      expect(checks()).toHaveLength(answer === 1 ? 1 : 0)
      expect(logged()).not.toContain('dispatched')
    }
  )

  it("leaves the user's own function from their startup file in charge, with no check", () => {
    const { run, checks, root } = rig(75)
    expect(
      run(shell, [shell.start], {
        userRc: shell.userClaude,
        env: [`ORCA_CLAUDE_PROFILE_POINTER=${join(root, 'pointer')}`]
      })
    ).toEqual([`claude '--resume' 'X'`, `claude|--mine|--resume|X|config=${root}/work`])
    expect(checks()).toEqual([])
  })

  it.skipIf(!shell.userAlias)('leaves a user alias in charge, with no check', () => {
    const { run, checks } = rig(75)
    expect(run(shell, [shell.start], { userRc: shell.userAlias })).toEqual([
      `claude '--resume' 'X'`,
      'claude|--aliased|--resume|X|config='
    ])
    expect(checks()).toEqual([])
  })

  it("checks inside Orca's account function, and refuses it once something replaced it", () => {
    const { run, checks, root } = rig(75)
    const pointer = join(root, 'pointer')
    writeFileSync(pointer, join(root, 'account'))
    const account = [`ORCA_CLAUDE_PROFILE_POINTER=${pointer}`]
    expect(run(shell, [shell.start], { env: account })).toEqual([
      `claude '--resume' 'X'`,
      `claude|--model|a b'c||config=${root}/account`
    ])
    expect(checks()).toEqual([`check claude ${ENTRY} ${TOKEN} config=${root}/account|--resume|X|`])
    const replaced = rig(75)
    expect(replaced.run(shell, [shell.replaceClaude, shell.start], { env: account })).toEqual([
      `claude '--resume' 'X'`,
      'claude|--replaced|--resume|X|config='
    ])
    expect(replaced.checks()).toEqual([])
  })

  it("puts Codex's fresh arguments through its own --no-daemon and pane identity handling", () => {
    const { run, original } = rig(75, 'codex', ['resume', 'X'])
    const output = run(shell, [shell.start])
    expect(output[0]).toBe(original)
    expect(output[1]).toMatch(
      /^codex\|--no-daemon\|-c\|shell_environment_policy\.set\.ORCA_TERMINAL_HANDLE='term-1'\|--model\|a b'c\|\|/
    )
  })

  it('checks a plain PATH agent the pane has no function for', () => {
    const { run, checks } = rig(75, 'opencode', ['--session', 'X'])
    expect(run(shell, [shell.start])[1]).toBe("opencode|--model|a b'c||config=")
    expect(checks()).toHaveLength(1)
  })
})

describe('bash history after a saved restore start', () => {
  it.skipIf(!existsSync('/bin/bash'))('records only the plain command', () => {
    const { run, original } = rig(1)
    // History on only for the prompt, as in an interactive shell after its startup files.
    const output = run(SHELLS[0], ['set -o history', SHELLS[0].start, 'history'])
    const recorded = output.filter((line) => /^\s*\d+\s/.test(line))
    expect(recorded.filter((line) => line.includes('__orca'))).toEqual([])
    expect(recorded.at(-2)).toMatch(
      new RegExp(`^\\s*\\d+\\s+${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    )
  })
})

describe('fish history after a saved restore start', () => {
  const fish = SHELLS.find((shell) => shell.name === 'fish')
  it.skipIf(!fish)('records only the plain command where fish has history append', () => {
    const { run, original } = rig(1)
    const output = run(fish!, [fish!.start, 'builtin history search --max 5'], {
      env: ['fish_history=orca_test']
    })
    expect(output.filter((line) => line.includes('__orca'))).toEqual([])
    // Shown once by the action, then listed once by history.
    expect(output.filter((line) => line === original)).toHaveLength(2)
    expect(output.at(-1)).toBe(original)
  })
})
