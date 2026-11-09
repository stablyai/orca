import { describe, expect, it } from 'vitest'
import { inspectSetupEnvVarNames } from './setup-env-var-name-imports'

function reader(files: Record<string, string>) {
  return async (path: string): Promise<string | null> => files[path] ?? null
}

describe('inspectSetupEnvVarNames', () => {
  it('collects names, never values, from Conductor, dev container and .env examples', async () => {
    const result = await inspectSetupEnvVarNames(
      reader({
        '.conductor/settings.toml': [
          '[scripts]',
          'setup = "pnpm install"',
          '[environment_variables]',
          'DATABASE_URL = "postgres://user:hunter2@db/app"',
          'lower_case = "x"'
        ].join('\n'),
        '.devcontainer/devcontainer.json': `{
          // comments are fine
          "containerEnv": { "STRIPE_KEY": "\${localEnv:STRIPE_KEY}", "PATH": "/x" },
          "remoteEnv": { "GITHUB_TOKEN": "\${localEnv:GH_PAT:default}" },
          "secrets": { "OPENAI_API_KEY": { "description": "x" } },
        }`,
        '.env.example': [
          '# comment',
          'export SENTRY_DSN=',
          'DATABASE_URL=dup',
          'ORCA_INTERNAL=1'
        ].join('\n')
      })
    )
    expect(result.names).toEqual([
      'DATABASE_URL',
      'OPENAI_API_KEY',
      'STRIPE_KEY',
      'GITHUB_TOKEN',
      'GH_PAT',
      'SENTRY_DSN'
    ])
    expect(result.files).toEqual([
      '.conductor/settings.toml',
      '.devcontainer/devcontainer.json',
      '.env.example'
    ])
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })

  it('returns nothing for a repo without those configs', async () => {
    expect(await inspectSetupEnvVarNames(reader({}))).toEqual({ names: [], files: [] })
  })
})
