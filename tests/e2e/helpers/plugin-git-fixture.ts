import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SSH_SHIM = join(
  process.cwd(),
  'src',
  'main',
  'plugins',
  'plugin-private-marketplace-ssh-shim.cjs'
)

function isolatedGitProcessEnv(gitEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    ...gitEnvironment
  }
}

export async function runGit(
  cwd: string,
  args: string[],
  gitEnvironment: NodeJS.ProcessEnv
): Promise<void> {
  await execFileAsync('git', args, { cwd, env: isolatedGitProcessEnv(gitEnvironment) })
}

export async function commitRepository(
  repository: string,
  gitEnvironment: NodeJS.ProcessEnv
): Promise<void> {
  await runGit(repository, ['init', '--quiet'], gitEnvironment)
  await runGit(repository, ['checkout', '--quiet', '-b', 'main'], gitEnvironment)
  await runGit(repository, ['add', '--all'], gitEnvironment)
  await runGit(
    repository,
    [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=orca-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    ],
    gitEnvironment
  )
  await runGit(repository, ['tag', 'v1.0.0'], gitEnvironment)
}

/** Git settings that serve `repositoryNames` from `repositories` as https://github.com/stablyai/<name>.git. */
export async function configureFixtureGit(
  home: string,
  repositories: string,
  repositoryNames: readonly string[]
): Promise<Record<string, string>> {
  const hooksDirectory = join(home, 'hooks')
  const configPath = join(home, '.gitconfig')
  await mkdir(hooksDirectory, { recursive: true })
  const gitEnvironment: Record<string, string> = {
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  // Why SSH: plugin downloads refuse the file transport even behind an insteadOf rewrite, so the
  // fixture repositories are served through the same GIT_SSH_COMMAND shim the unit tests use.
  gitEnvironment.GIT_SSH_COMMAND = `"${process.execPath.replaceAll('\\', '/')}" "${SSH_SHIM.replaceAll('\\', '/')}"`
  gitEnvironment.GIT_SSH_VARIANT = 'ssh'
  gitEnvironment.ORCA_TEST_SSH_REPOSITORIES = JSON.stringify(
    Object.fromEntries(
      repositoryNames.map((name) => [`/${name}.git`, join(repositories, `${name}.git`)])
    )
  )
  const entries = [
    ['url.ssh://git@fixtures.invalid/.insteadOf', 'https://github.com/stablyai/'],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['core.hooksPath', hooksDirectory]
  ] as const
  for (const [key, value] of entries) {
    await runGit(home, ['config', '--file', configPath, key, value], gitEnvironment)
  }
  return gitEnvironment
}

export async function headCommit(
  repository: string,
  gitEnvironment: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    env: isolatedGitProcessEnv(gitEnvironment)
  })
  return stdout.trim()
}
