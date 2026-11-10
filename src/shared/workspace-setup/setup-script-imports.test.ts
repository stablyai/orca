import { describe, expect, it } from 'vitest'
import { inspectSetupScriptImportCandidates } from './setup-script-imports'

function makeReader(files: Record<string, string>) {
  return async (relativePath: string): Promise<string | null> => files[relativePath] ?? null
}

describe('inspectSetupScriptImportCandidates', () => {
  it('applies Superset local before and after setup overlays', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        '.superset/config.json': JSON.stringify({
          setup: ['bun install'],
          teardown: ['docker compose down'],
          cwd: 'packages/web'
        }),
        '.superset/config.local.json': JSON.stringify({
          setup: {
            before: ['corepack enable'],
            after: ['bun run db:migrate']
          },
          teardown: ['docker compose down --remove-orphans'],
          run: ['bun dev']
        })
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'superset',
        label: 'Superset',
        files: ['.superset/config.json', '.superset/config.local.json'],
        setup: 'corepack enable\nbun install\nbun run db:migrate',
        archive: 'docker compose down --remove-orphans',
        unsupportedFields: ['cwd', 'config.local.run']
      }
    ])
  })

  it('imports setup commands from cmux project config', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        '.cmux/cmux.json': JSON.stringify({
          commands: [
            {
              name: 'Run Unit Tests',
              keywords: ['test', 'unit'],
              command: './scripts/test-unit.sh'
            },
            {
              name: 'Setup',
              description: 'Initialize submodules and build dependencies',
              keywords: ['setup', 'init', 'install'],
              command: './scripts/setup.sh',
              confirm: true,
              cwd: 'packages/web'
            }
          ]
        })
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'cmux',
        label: 'cmux',
        files: ['.cmux/cmux.json'],
        setup: './scripts/setup.sh',
        unsupportedFields: ['commands.1.confirm', 'commands.1.cwd']
      }
    ])
  })

  it('imports setup and cleanup scripts from Codex environment config', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        '.codex/environments/environment.toml': `
[setup]
script = """
npm ci
pnpm build
"""

[cleanup]
script = "pnpm clean"

[actions.test]
command = "pnpm test"
`
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'codex',
        label: 'Codex environment',
        files: ['.codex/environments/environment.toml'],
        setup: 'npm ci\npnpm build',
        archive: 'pnpm clean',
        unsupportedFields: ['[actions.test]']
      }
    ])
  })
})
