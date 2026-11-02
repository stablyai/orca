import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
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
  annotateSavedRestore,
  FISH_SAVED_RESTORE_INSTALL,
  POSIX_SAVED_RESTORE_CAPTURE,
  POSIX_SAVED_RESTORE_INSTALL,
  renderSavedRestoreStartupCommand,
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_ENTRY_ENV,
  SAVED_RESTORE_FRESH_ARGS_ENV,
  SAVED_RESTORE_SCRIPT_ENV,
  withoutSavedRestoreAnnotation
} from './saved-restore-dispatch'
import { getFishSavedRestoreScript, getPosixSavedRestoreScript } from './saved-restore-scripts'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

// The production pieces a root shell runs, in its order: capture before startup files, Orca's
// agent functions, the installer, then generated lines typed into that same long-lived shell. A
// stand-in CLI records each check and answers as main would: 75 = start fresh, else resume.
const ENTRY = '0123456789abcdef'
const TOKEN = '0123456789abcdef0123456789abcdef'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

const SHELLS = [
  {
    name: 'bash',
    path: '/bin/bash',
    args: ['--norc', '--noprofile', '-c'],
    root: () =>
      `${POSIX_SAVED_RESTORE_CAPTURE}\n${getPosixCodexShellLaunchPreflight()}${getPosixClaudeShellFunction()}${POSIX_SAVED_RESTORE_INSTALL}`,
    unsetUserClaude: 'unset -f claude',
    userClaude: 'claude() { echo mine "$@"; }'
  },
  {
    name: 'zsh',
    path: '/bin/zsh',
    args: ['-f', '-c'],
    root: () =>
      `${POSIX_SAVED_RESTORE_CAPTURE}\n${getPosixCodexShellLaunchPreflight()}${getPosixClaudeShellFunction()}${POSIX_SAVED_RESTORE_INSTALL}`,
    unsetUserClaude: 'unset -f claude',
    userClaude: 'claude() { echo mine "$@"; }'
  },
  {
    name: 'fish',
    path: '/opt/homebrew/bin/fish',
    args: ['--no-config', '-c'],
    root: () =>
      `${getFishCodexShellLaunchPreflight()}${getFishClaudeShellFunction()}\n${FISH_SAVED_RESTORE_INSTALL}`,
    unsetUserClaude: 'functions -e claude',
    userClaude: 'function claude; echo mine $argv; end'
  }
].filter((shell) => process.platform !== 'win32' && existsSync(shell.path))

function rig(answer: number | 'no-cli') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-restore-dispatch-')))
  roots.push(root)
  const log = join(root, 'check.log')
  const check = join(root, 'orca')
  writeFileSync(
    check,
    `#!/bin/sh
if [ "$3" = --phase ]; then printf 'dispatched %s %s\\n' "$6" "$8" >> "${log}"; exit 0; fi
printf 'check %s %s %s|' "$4" "$6" "$8" >> "${log}"
tr '\\0' '|' >> "${log}"; printf '\\n' >> "${log}"
exit ${answer === 'no-cli' ? 0 : answer}
`
  )
  for (const agent of ['claude', 'codex', 'opencode']) {
    writeFileSync(
      join(root, agent),
      `#!/bin/sh\n[ "$1" = --help ] && { echo --no-daemon; exit 0; }\nprintf '%s|' ${agent} "$@"; printf 'entry=%s\\n' "\${${SAVED_RESTORE_ENTRY_ENV}-none}"\n`
    )
  }
  for (const file of ['orca', 'claude', 'codex', 'opencode']) {
    chmodSync(join(root, file), 0o755)
  }
  writeFileSync(join(root, 'restore.sh'), getPosixSavedRestoreScript())
  writeFileSync(join(root, 'restore.fish'), getFishSavedRestoreScript())
  const run = (shell: (typeof SHELLS)[number], lines: string[], armed = true) => {
    const env = [
      '-i',
      `HOME=${root}`,
      `PATH=${root}:/usr/bin:/bin`,
      `${SAVED_RESTORE_CHECK_ENV}=${answer === 'no-cli' ? join(root, 'missing') : check}`,
      `${SAVED_RESTORE_FRESH_ARGS_ENV}='--model' 'a b'"'"'c'`,
      'ORCA_TERMINAL_HANDLE=term-1',
      ...(armed
        ? [
            `${SAVED_RESTORE_ENTRY_ENV}=${ENTRY}`,
            `${SAVED_RESTORE_SCRIPT_ENV}=${join(root, 'restore')}`
          ]
        : [])
    ]
    const result = spawnSync(
      '/usr/bin/env',
      [...env, shell.path, ...shell.args, `${shell.root()}\n${lines.join('\n')}`],
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
  return { run, checks, logged }
}

describe.each(SHELLS)('the generated restore dispatch in one long-lived $name shell', (shell) => {
  const line = (original: string) =>
    renderSavedRestoreStartupCommand(annotateSavedRestore(original, ENTRY, TOKEN), shell.path)
  const CLAUDE = `claude '--resume' 'X'`

  it('runs fresh once; a recalled line and a re-run installer only reach the original command', async () => {
    const { run, checks, logged } = rig(75)
    expect(
      run(shell, [
        line(CLAUDE),
        shell.name === 'fish' ? FISH_SAVED_RESTORE_INSTALL : POSIX_SAVED_RESTORE_INSTALL,
        line(CLAUDE)
      ])
    ).toEqual(["claude|--model|a b'c|entry=none", 'claude|--resume|X|entry=none'])
    expect(checks()).toEqual([`check claude ${ENTRY} ${TOKEN}|--resume|X|`])
    await vi.waitFor(() => expect(logged()).toContain(`dispatched ${ENTRY} ${TOKEN}`))
  })

  it.each([1, 'no-cli'] as const)(
    'replays the original command without a second check when the first never reached main (%s)',
    (answer) => {
      const { run, checks } = rig(answer)
      expect(run(shell, [line(CLAUDE), line(CLAUDE)])).toEqual([
        'claude|--resume|X|entry=none',
        'claude|--resume|X|entry=none'
      ])
      expect(checks()).toHaveLength(answer === 1 ? 1 : 0)
    }
  )

  it("lets the user's own function win with no check, and a later recall stays original", () => {
    const { run, checks } = rig(75)
    expect(
      run(shell, [shell.userClaude, line(CLAUDE), shell.unsetUserClaude, line(CLAUDE)])
    ).toEqual(['mine --resume X', 'claude|--resume|X|entry=none'])
    expect(checks()).toEqual([])
  })

  it('reaches no entry in another pane, a typed command, or a nested shell', () => {
    const { run, checks } = rig(75)
    expect(run(shell, [line(CLAUDE), `claude --resume X`], false)).toEqual([
      'claude|--resume|X|entry=none',
      'claude|--resume|X|entry=none'
    ])
    // A child process started from this shell inherits no installer input.
    expect(run(shell, [`/bin/sh -c 'echo "\${${SAVED_RESTORE_ENTRY_ENV}-unset}"'`])).toEqual([
      'unset'
    ])
    expect(checks()).toEqual([])
  })

  it("puts Codex's fresh arguments through its own --no-daemon and pane identity handling", () => {
    const { run } = rig(75)
    expect(run(shell, [line(`codex 'resume' 'X'`)])[0]).toMatch(
      /^codex\|--no-daemon\|-c\|shell_environment_policy\.set\.ORCA_TERMINAL_HANDLE='term-1'\|--model\|a b'c\|/
    )
  })

  it('checks a plain PATH agent the pane has no function for', () => {
    const { run, checks } = rig(75)
    expect(run(shell, [line(`opencode '--session' 'X'`)])).toEqual([
      "opencode|--model|a b'c|entry=none"
    ])
    expect(checks()).toHaveLength(1)
  })
})

describe('the restore annotation', () => {
  it('is dropped for shells without an installer and invisible to recognition', () => {
    const annotated = annotateSavedRestore(`codex 'resume' 'X'`, ENTRY, TOKEN)
    expect(renderSavedRestoreStartupCommand(annotated, '/bin/sh')).toBe(`codex 'resume' 'X'`)
    expect(renderSavedRestoreStartupCommand(annotated, 'C:\\Windows\\cmd.exe')).toBe(
      `codex 'resume' 'X'`
    )
    expect(renderSavedRestoreStartupCommand(`codex resume X`, '/bin/zsh')).toBe('codex resume X')
    expect(withoutSavedRestoreAnnotation(annotated)).toBe(`codex 'resume' 'X'`)
    expect(recognizeAgentProcessFromCommandLine(annotated)?.agent).toBe('codex')
    expect(
      renderSavedRestoreStartupCommand(
        annotateSavedRestore(`& 'codex' 'resume' 'X'`, ENTRY, TOKEN),
        'pwsh.exe'
      )
    ).toBe(
      `if (Test-Path function:__orca_sr_${ENTRY}) { __orca_sr_${ENTRY} '${TOKEN}' '& ''codex'' ''resume'' ''X''' 'codex' 'resume' 'X' } else { & 'codex' 'resume' 'X' }`
    )
  })
})
