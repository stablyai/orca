import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import {
  unwrapCodexDirectLaunchCommand,
  withCodexDirectLaunchCommand
} from './codex-startup-image-command'

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
      unwrapCodexDirectLaunchCommand(
        withCodexDirectLaunchCommand(`'${codex}' --x`, 'posix', { images: true })
      )
    ).toBe(`'${codex}' --x`)
  }
)
