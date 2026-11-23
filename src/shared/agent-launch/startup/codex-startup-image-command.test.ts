import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import {
  prepareShellNativeAgentLaunch,
  unwrapDirectAgentLaunchCommand,
  withCodexDirectLaunchCommand
} from './codex-startup-image-command'
import { recognizeAgentProcessFromCommandLine } from '../../agent-status/process/agent-process-recognition'

const folder = mkdtempSync(join(tmpdir(), 'orca codex '))
const codex = join(folder, 'codex')
writeFileSync(codex, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n')
chmodSync(codex, 0o755)
afterAll(() => rmSync(folder, { recursive: true, force: true }))

function run(args: string): string[] {
  const command = withCodexDirectLaunchCommand(`'${codex}' ${args}`, 'posix', { images: false })
  const shell = spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ORCA_TERMINAL_HANDLE: 'term_1', ORCA_WORKTREE_ID: 'wt 1' }
  })
  return shell.stdout.trimEnd().split('\n')
}

it.skipIf(process.platform === 'win32')(
  'gives Codex run by path the caller identity the codex shell function would',
  () => {
    expect(run("--model 'gpt x'")).toEqual([
      '-c',
      "shell_environment_policy.set.ORCA_WORKTREE_ID='wt 1'",
      '-c',
      "shell_environment_policy.set.ORCA_TERMINAL_HANDLE='term_1'",
      '--model',
      'gpt x'
    ])
    // A command that shares a Codex server keeps that server's identity.
    expect(run('agents list')).toEqual(['agents', 'list'])
    expect(
      unwrapDirectAgentLaunchCommand(
        withCodexDirectLaunchCommand(`'${codex}' --x`, 'posix', { images: true })
      )
    ).toBe(`'${codex}' --x`)
  }
)

it.skipIf(process.platform === 'win32')(
  'routes full-path Claude to the selected account and preserves its argv',
  () => {
    const claude = join(folder, 'claude')
    const pointer = join(folder, 'selected-account')
    const work = join(folder, 'accounts', 'work')
    const personal = join(folder, 'accounts', 'personal')
    mkdirSync(work, { recursive: true })
    writeFileSync(pointer, `${work}\n`)
    writeFileSync(
      claude,
      '#!/bin/sh\nprintf \'%s\\n\' "$CLAUDE_CONFIG_DIR" "$ORCA_CLAUDE_INJECTED_CONFIG_DIR" "$@"\n'
    )
    chmodSync(claude, 0o755)
    const invocation = `'${claude}' --resume 'abc def'`
    const command = prepareShellNativeAgentLaunch(invocation, 'posix', false)
    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        ORCA_CLAUDE_PROFILE_POINTER: pointer,
        ORCA_CLAUDE_USER_CONFIG_DIR: personal,
        CLAUDE_CONFIG_DIR: personal
      }
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${work}\n${work}\n--resume\nabc def\n`)
    expect(unwrapDirectAgentLaunchCommand(command)).toBe(invocation)
    expect(recognizeAgentProcessFromCommandLine(command)?.agent).toBe('claude')
  }
)

it.skipIf(process.platform === 'win32')(
  'prepares the selected Codex inside cwd and environment prefixes',
  () => {
    const scope = mkdtempSync(join(tmpdir(), 'orca codex scope '))
    try {
      const executable = join(scope, 'codex')
      const preflight = join(scope, 'prepare')
      writeFileSync(
        executable,
        `#!/bin/sh
if [ "$1" = --help ]; then
  printf '%s\n' --no-daemon
  exit
fi
printf '%s\n' "$PWD" "$CODEX_HOME" "$DEBUG" "\${TRACE-unset}" "$SSH_CONNECTION" "$KITTY_WINDOW_ID" "$@"
`
      )
      writeFileSync(preflight, '#!/bin/sh\nprintf "%s" "$CODEX_HOME" > prepared\n')
      chmodSync(executable, 0o755)
      chmodSync(preflight, 0o755)
      const command = withCodexDirectLaunchCommand(
        `cd '${scope}'&&CODEX_HOME='/account' env -u TRACE DEBUG=1 '${executable}' resume 'abc'`,
        'posix',
        { images: true, probeInShell: true }
      )
      const result = spawnSync('/bin/sh', ['-c', command], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          TRACE: 'ambient',
          ORCA_REMOTE_VIEWER_CLIPBOARD: '1',
          ORCA_CODEX_LAUNCH_PREFLIGHT: preflight,
          ORCA_TERMINAL_HANDLE: 'term_1',
          ORCA_IMAGE_PROTOCOL: 'kitty'
        }
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trimEnd().split('\n')).toEqual([
        scope,
        '/account',
        '1',
        'unset',
        '127.0.0.1 0 127.0.0.1 0',
        '0',
        '-c',
        "shell_environment_policy.set.SSH_CONNECTION=''",
        '-c',
        "shell_environment_policy.set.ORCA_TERMINAL_HANDLE='term_1'",
        '--no-daemon',
        'resume',
        'abc'
      ])
      expect(readFileSync(join(scope, 'prepared'), 'utf8')).toBe('/account')
    } finally {
      rmSync(scope, { recursive: true, force: true })
    }
  }
)

it('routes the PowerShell argument array through native escaping after adding Codex identity', () => {
  const command = withCodexDirectLaunchCommand(
    `$env:CODEX_HOME='C:\\account'; & 'C:\\O’’Brien\\codex.exe' --no-daemon --settings '{"fastMode":false}' 'O’’Brien’’s "quoted" prompt'`,
    'powershell',
    { images: false }
  )
  expect(command).toMatch(/^\$env:CODEX_HOME='C:\\account'; & \{/)
  expect(command).toContain(
    '$orcaNativeArgs = @(__OrcaEscapeNativeArgs $orcaProgram ($orcaCodexIdentity + @($args))); & $orcaProgram @orcaNativeArgs'
  )
  expect(command).toContain('$mode = $PSNativeCommandArgumentPassing')
  expect(command).toContain('$PSVersionTable.PSVersion.Major -lt 6')
  expect(command).toMatch(
    /'C:\\O’’Brien\\codex\.exe' '--no-daemon' '--settings' '\{"fastMode":false\}' 'O’’Brien’’s "quoted" prompt'$/
  )
})
