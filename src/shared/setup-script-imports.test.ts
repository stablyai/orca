import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectSetupScriptImportCandidates } from './setup-script-imports'
import {
  SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES,
  SETUP_SCRIPT_IMPORT_MAX_CMUX_COMMANDS,
  SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS,
  SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES,
  SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS,
  SETUP_SCRIPT_IMPORT_MAX_TOML_LINES
} from './setup-script-import-limits'

function makeReader(files: Record<string, string>) {
  return async (relativePath: string): Promise<string | null> => files[relativePath] ?? null
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('inspectSetupScriptImportCandidates', () => {
  it('parses the exact input boundary and rejects +1 before JSON parsing', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    const suffix = '{"setup":"pnpm install"}'
    const exact = `${' '.repeat(SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES - suffix.length)}${suffix}`

    await expect(
      inspectSetupScriptImportCandidates(makeReader({ '.superset/config.json': exact }))
    ).resolves.toHaveLength(1)
    expect(parse).toHaveBeenCalledOnce()

    parse.mockClear()
    await expect(
      inspectSetupScriptImportCandidates(makeReader({ '.superset/config.json': `${exact} ` }))
    ).resolves.toEqual([])
    expect(parse).not.toHaveBeenCalled()
  })

  it('rejects multibyte input over the byte cap before JSON parsing', async () => {
    const parse = vi.spyOn(JSON, 'parse')

    await expect(
      inspectSetupScriptImportCandidates(
        makeReader({
          '.superset/config.json': 'é'.repeat(SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES / 2 + 1)
        })
      )
    ).resolves.toEqual([])
    expect(parse).not.toHaveBeenCalled()
  })

  it('admits the exact command-part cardinality and rejects +1', async () => {
    const inspect = (setup: string[]) =>
      inspectSetupScriptImportCandidates(
        makeReader({ '.superset/config.json': JSON.stringify({ setup }) })
      )
    const exact = Array.from({ length: SETUP_SCRIPT_IMPORT_MAX_COMMAND_PARTS }, () => 'x')

    await expect(inspect(exact)).resolves.toMatchObject([{ setup: exact.join('\n') }])
    await expect(inspect([...exact, 'overflow'])).resolves.toEqual([])
  })

  it('admits an exact-size script field and rejects +1', async () => {
    const inspect = (setup: string) =>
      inspectSetupScriptImportCandidates(
        makeReader({ '.superset/config.json': JSON.stringify({ setup }) })
      )
    const exact = 'x'.repeat(SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS)
    const exactUtf8 = 'é'.repeat(SETUP_SCRIPT_IMPORT_MAX_FIELD_BYTES / 2)

    await expect(inspect(exact)).resolves.toMatchObject([{ setup: exact }])
    await expect(inspect(`${exact}x`)).resolves.toEqual([])
    await expect(inspect(exactUtf8)).resolves.toMatchObject([{ setup: exactUtf8 }])
    await expect(inspect(`${exactUtf8}é`)).resolves.toEqual([])
  })

  it('bounds Codex multiline script accumulation at the exact field limit', async () => {
    const inspect = (setup: string) =>
      inspectSetupScriptImportCandidates(
        makeReader({
          '.codex/environments/environment.toml': `[setup]\nscript = """${setup}"""`
        })
      )
    const exact = 'x'.repeat(SETUP_SCRIPT_IMPORT_MAX_FIELD_CODE_UNITS)

    await expect(inspect(exact)).resolves.toMatchObject([{ provider: 'codex', setup: exact }])
    await expect(inspect(`${exact}x`)).resolves.toEqual([])
  })

  it('bounds cmux command scans and Codex TOML line splitting', async () => {
    const commands = Array.from({ length: SETUP_SCRIPT_IMPORT_MAX_CMUX_COMMANDS }, (_, index) => ({
      name: index === SETUP_SCRIPT_IMPORT_MAX_CMUX_COMMANDS - 1 ? 'Setup' : 'Build',
      command: 'pnpm install'
    }))
    await expect(
      inspectSetupScriptImportCandidates(
        makeReader({ '.cmux/cmux.json': JSON.stringify({ commands }) })
      )
    ).resolves.toMatchObject([{ provider: 'cmux' }])
    await expect(
      inspectSetupScriptImportCandidates(
        makeReader({
          '.cmux/cmux.json': JSON.stringify({
            commands: [...commands, { name: 'Overflow', command: 'true' }]
          })
        })
      )
    ).resolves.toEqual([])

    const exactToml = `[setup]\nscript = "pnpm install"${'\n'.repeat(
      SETUP_SCRIPT_IMPORT_MAX_TOML_LINES - 2
    )}`
    await expect(
      inspectSetupScriptImportCandidates(
        makeReader({ '.codex/environments/environment.toml': exactToml })
      )
    ).resolves.toMatchObject([{ provider: 'codex' }])
    await expect(
      inspectSetupScriptImportCandidates(
        makeReader({ '.codex/environments/environment.toml': `${exactToml}\n` })
      )
    ).resolves.toEqual([])
  })

  it('imports setup and teardown commands from Superset config', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        '.superset/config.json': JSON.stringify({
          setup: ['./.superset/setup.sh', 'bun install'],
          teardown: ['./.superset/teardown.sh'],
          run: ['bun dev']
        })
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'superset',
        label: 'Superset',
        files: ['.superset/config.json'],
        setup: './.superset/setup.sh\nbun install',
        archive: './.superset/teardown.sh',
        unsupportedFields: ['run']
      }
    ])
  })

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

  it('reports unsupported Superset local script object fields', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        '.superset/config.json': JSON.stringify({
          setup: ['bun install']
        }),
        '.superset/config.local.json': JSON.stringify({
          setup: {
            before: ['corepack enable'],
            after: ['bun run db:migrate'],
            cwd: 'packages/web'
          }
        })
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'superset',
        label: 'Superset',
        files: ['.superset/config.json', '.superset/config.local.json'],
        setup: 'corepack enable\nbun install\nbun run db:migrate',
        archive: undefined,
        unsupportedFields: ['config.local.setup.cwd']
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

  it('imports setup commands from root cmux config when project config is absent', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'cmux.json': JSON.stringify({
          commands: [
            {
              title: 'Workspace Setup',
              keywords: ['setup'],
              command: 'pnpm install'
            }
          ]
        })
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'cmux',
        label: 'cmux',
        files: ['cmux.json'],
        setup: 'pnpm install',
        unsupportedFields: []
      }
    ])
  })

  it('imports setup and archive commands from Conductor config', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'conductor.json': JSON.stringify({
          scripts: {
            setup: 'pnpm install',
            archive: 'pnpm clean',
            run: 'pnpm dev'
          },
          runScriptMode: 'manual'
        })
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'conductor',
        label: 'Conductor',
        files: ['conductor.json'],
        setup: 'pnpm install',
        archive: 'pnpm clean',
        unsupportedFields: ['runScriptMode', 'scripts.run']
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

  it('ignores malformed or setup-less configs', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        '.superset/config.json': '{',
        'conductor.json': JSON.stringify({ scripts: { run: 'pnpm dev' } }),
        '.codex/environments/environment.toml': '[cleanup]\nscript = "pnpm clean"',
        '.cmux/cmux.json': JSON.stringify({
          commands: [{ name: 'Build', keywords: ['build'], command: 'pnpm build' }]
        })
      })
    )

    expect(candidates).toEqual([])
  })
})
