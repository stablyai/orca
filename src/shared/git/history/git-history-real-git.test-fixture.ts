import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveExecutableCommand } from '../../shell/command-resolution/node-cli-command-resolution'
import type { GitHistoryExecutor } from './git-history-types'

/** A temp root plus a real Git executor isolated from the machine's Git config and GIT_* env. */
export async function createRealGitHistoryFixture(prefix: string) {
  const executable = resolveExecutableCommand(process.env.ORCA_TEST_GIT_BINARY ?? 'git')
  if (!executable) {
    throw new Error('Git is required for real-git history tests')
  }
  // realpath so paths Git reports match on macOS, where tmpdir() sits behind /var -> /private/var.
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'no-global-git-config')
  }
  const git: GitHistoryExecutor = async (args, cwd, input) => {
    const result = await runProcess({
      program: executable,
      args,
      cwd,
      env,
      ...(input === undefined ? {} : { input }),
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)
    }
    return { stdout: result.stdout }
  }
  return { root, git, cleanup: () => rm(root, { recursive: true, force: true }) }
}
