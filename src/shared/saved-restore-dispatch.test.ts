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
import { getFishAgentShellFunctions, getPosixAgentShellFunctions } from './agent-shell-functions'
import {
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_FRESH_ARGS_ENV,
  withoutSavedRestoreProof,
  withSavedRestoreProof
} from './saved-restore-dispatch'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

// The production generated line run by real shells, with a stand-in CLI that answers as main
// would: 75 = start fresh, anything else = resume. The stand-in records what the check reported.
const PROOF = '0123456789abcdef0123456789abcdef'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

const SHELLS = [
  {
    name: 'bash',
    path: '/bin/bash',
    args: ['--norc', '--noprofile', '-c'],
    fns: getPosixAgentShellFunctions
  },
  { name: 'zsh', path: '/bin/zsh', args: ['-f', '-c'], fns: getPosixAgentShellFunctions },
  {
    name: 'fish',
    path: '/opt/homebrew/bin/fish',
    args: ['--no-config', '-c'],
    fns: getFishAgentShellFunctions
  }
].filter((shell) => process.platform !== 'win32' && existsSync(shell.path))

function rig(answer: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-restore-dispatch-')))
  roots.push(root)
  const log = join(root, 'check.log')
  const check = join(root, 'orca')
  writeFileSync(
    check,
    `#!/bin/sh
if [ "$3" = --phase ]; then printf 'dispatched %s\\n' "$6" >> "${log}"; exit 0; fi
printf 'check %s %s codex=%s\\n' "$4" "$6" "\${CODEX_HOME-}" >> "${log}"
tr '\\0' '|' >> "${log}"; printf '\\n' >> "${log}"
exit ${answer}
`
  )
  for (const agent of ['claude', 'codex', 'opencode']) {
    writeFileSync(
      join(root, agent),
      `#!/bin/sh\n[ "$1" = --help ] && { echo --no-daemon; exit 0; }\nprintf '%s|' ${agent} "$@"; printf 'proof=%s\\n' "\${ORCA_SAVED_RESTORE_PROOF-none}"\n`
    )
  }
  for (const file of ['orca', 'claude', 'codex', 'opencode']) {
    chmodSync(join(root, file), 0o755)
  }
  const run = (shell: (typeof SHELLS)[number], line: string, extra = '') => {
    const result = spawnSync(
      '/usr/bin/env',
      [
        '-i',
        `HOME=${root}`,
        `PATH=${root}:/usr/bin:/bin`,
        `${SAVED_RESTORE_CHECK_ENV}=${check}`,
        `${SAVED_RESTORE_FRESH_ARGS_ENV}='--model' 'a b'"'"'c'`,
        'ORCA_TERMINAL_HANDLE=term-1',
        shell.path,
        ...shell.args,
        `${shell.fns()}\n${extra}\n${line}`
      ],
      { encoding: 'utf8', cwd: root }
    )
    return result.stdout.trim()
  }
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
  return { run, logged }
}

describe.each(SHELLS)('the generated restore line in $name', (shell) => {
  const generated = (command: string) => withSavedRestoreProof(command, PROOF, 'posix')

  it('runs the fresh arguments on a fresh answer, reports the dispatch, and never passes the proof on', async () => {
    const { run, logged } = rig(75)
    expect(run(shell, generated(`claude '--resume' 'X'`))).toBe("claude|--model|a b'c|proof=none")
    expect(logged()).toContain(`check claude ${PROOF}`)
    expect(logged()).toContain('--resume|X|')
    await vi.waitFor(() => expect(logged()).toContain(`dispatched ${PROOF}`))
  })

  it('keeps the original arguments on a resume answer, and a typed command never checks', () => {
    const { run, logged } = rig(0)
    expect(run(shell, generated(`opencode '--session' 'X'`))).toBe(
      'opencode|--session|X|proof=none'
    )
    expect(logged()).toContain(`check opencode ${PROOF}`)
    expect(logged()).not.toContain('dispatched')
    const typed = rig(75)
    expect(typed.run(shell, `claude --resume X`)).toBe('claude|--resume|X|proof=none')
    expect(typed.logged()).toBe('')
  })

  it("puts Codex's fresh arguments through its own --no-daemon and pane identity handling", () => {
    const { run } = rig(75)
    const output = run(shell, generated(`codex 'resume' 'X'`))
    expect(output).toMatch(
      /^codex\|--no-daemon\|-c\|shell_environment_policy\.set\.ORCA_TERMINAL_HANDLE='term-1'\|--model\|a b'c\|/
    )
  })

  it("never shadows the user's own function of the same name", () => {
    const { run, logged } = rig(75)
    const own =
      shell.name === 'fish'
        ? 'function opencode; echo mine $argv; end'
        : 'opencode() { echo mine "$@"; }'
    expect(run(shell, generated(`opencode '--session' 'X'`), own)).toBe('mine --session X')
    expect(logged()).toBe('')
  })
})

describe('the proof on the generated line', () => {
  it('is invisible to recognition, and stripped only in its exact generated form', () => {
    const posix = withSavedRestoreProof(`codex 'resume' 'X'`, PROOF, 'posix')
    const pwsh = withSavedRestoreProof(`& 'codex' 'resume' 'X'`, PROOF, 'powershell')
    expect(withoutSavedRestoreProof(posix)).toBe(`codex 'resume' 'X'`)
    expect(withoutSavedRestoreProof(pwsh)).toBe(`& 'codex' 'resume' 'X'`)
    expect(recognizeAgentProcessFromCommandLine(posix)?.agent).toBe('codex')
    expect(withoutSavedRestoreProof(`ORCA_SAVED_RESTORE_PROOF=x codex`)).toBe(
      'ORCA_SAVED_RESTORE_PROOF=x codex'
    )
  })
})
