import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  ensureOrcaRuntimeLaunched,
  parseJsonOutput,
  runOrcaCli
} from './helpers/computer-cli-driver'

// End-to-end coverage for the `orca terminal create --env` CLI flag against a REAL
// runtime, reusing the same CLI-driver harness the computer-use e2e suites use
// (compiled dev CLI → live runtime). Verifies the two seams the unit/runtime tests
// cannot: that the flag survives a real CLI → RPC → pty round-trip and lands in the
// spawned process env. Opt-in (ORCA_CLI_E2E=1) and POSIX-only (verifies via `env`).

const execFileAsync = promisify(execFile)
const PROJECT_ID = 'github:orca-e2e/testrepo'
const REMOTE_URL = 'https://github.com/orca-e2e/testrepo.git'
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const e2eOptIn = process.env.ORCA_CLI_E2E === '1'
const isPosix = process.platform !== 'win32'

type WorktreeCreateResult = { result: { worktree: { id: string; path: string } } }

describe.skipIf(!e2eOptIn || !isPosix)('orca CLI: terminal create --env (real runtime)', () => {
  let repoDir: string
  let worktreePath: string
  let worktreeSelector: string

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'orca-cli-e2e-repo-'))
    const git = (args: string[]) => execFileAsync('git', args, { cwd: repoDir })
    await git(['init'])
    // A git remote gives the folder a deterministic project identity, which
    // `project setup-existing-folder` requires to import it.
    await git(['remote', 'add', 'origin', REMOTE_URL])
    await git([
      '-c',
      'user.email=e2e@orca.test',
      '-c',
      'user.name=e2e',
      'commit',
      '--allow-empty',
      '-m',
      'init'
    ])

    await ensureOrcaRuntimeLaunched()

    // Register the throwaway repo, then materialize a worktree to create a terminal in.
    await runOrcaCli([
      'project',
      'setup-existing-folder',
      '--project',
      PROJECT_ID,
      '--host',
      'local',
      '--path',
      repoDir,
      '--kind',
      'git',
      '--json'
    ])
    const created = parseJsonOutput<WorktreeCreateResult>(
      (
        await runOrcaCli([
          'worktree',
          'create',
          '--project',
          PROJECT_ID,
          '--host',
          'local',
          '--name',
          'e2e-main',
          '--no-parent',
          '--setup',
          'skip',
          '--json'
        ])
      ).stdout
    )
    worktreePath = created.result.worktree.path
    worktreeSelector = `id:${created.result.worktree.id}`
  }, 60000)

  afterAll(async () => {
    // Only clean up what this test created (its worktree); leave the shared runtime
    // running, matching the mac/linux computer-use suites, which reuse it rather
    // than tearing it down (only the windows serve-based suites call stopOrcaRuntime).
    if (worktreeSelector) {
      await runOrcaCli(['worktree', 'rm', '--worktree', worktreeSelector, '--json']).catch(() => {})
    }
    // worktreePath is <workspaces>/<repo>/e2e-main; also drop its parent workspace
    // dir so nothing accumulates under ~/orca/workspaces.
    const dirs = [repoDir, worktreePath, worktreePath ? dirname(worktreePath) : '']
    for (const dir of dirs) {
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  })

  test('injects repeated --env KEY=VALUE into the spawned terminal pty', async () => {
    const outFile = join(repoDir, 'env-dump.txt')
    const script = join(repoDir, 'dump-env.sh')
    await writeFile(script, `#!/bin/sh\nenv > "${outFile}"\nsleep 30\n`)
    await chmod(script, 0o755)

    await runOrcaCli([
      'terminal',
      'create',
      '--worktree',
      worktreeSelector,
      '--command',
      script,
      '--env',
      'CALLER_TOKEN=abc123',
      '--env',
      'CALLER_ID=42',
      '--json'
    ])

    // The dumped env appears once the pty has run the command.
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        await access(outFile)
        break
      } catch {
        await delay(250)
      }
    }
    const env = await readFile(outFile, 'utf8')
    expect(env).toMatch(/^CALLER_TOKEN=abc123$/m)
    expect(env).toMatch(/^CALLER_ID=42$/m)
  }, 30000)

  test('rejects a malformed --env value that is not KEY=VALUE', async () => {
    await expect(
      runOrcaCli([
        'terminal',
        'create',
        '--worktree',
        worktreeSelector,
        '--command',
        'sh',
        '--env',
        'NOEQUALS',
        '--json'
      ])
    ).rejects.toThrow(/--env must be KEY=VALUE/)
  })
})
