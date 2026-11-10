import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from '../orca-yaml'
import { inspectSetupScriptImportCandidates } from './setup-script-imports'
import { formatSetupScriptImportAsOrcaYaml } from './setup-script-import-orca-yaml'

function fixture(name: string): string {
  return readFileSync(
    new URL(`./__fixtures__/setup-script-imports/${name}`, import.meta.url),
    'utf8'
  )
}

async function inspectConductor(files: Record<string, string>) {
  const candidates = await inspectSetupScriptImportCandidates(
    async (relativePath) => files[relativePath] ?? null
  )
  return candidates.find((candidate) => candidate.provider === 'conductor')
}

describe('Conductor run actions', () => {
  it('imports named actions, run_mode and auto_run_after_setup from the docs example', async () => {
    const candidate = await inspectConductor({
      '.conductor/settings.toml': fixture('conductor-settings-docs-example.toml')
    })
    expect(candidate).toEqual({
      provider: 'conductor',
      label: 'Conductor',
      files: ['.conductor/settings.toml'],
      setup: 'pnpm install',
      archive: 'pnpm clean',
      run: [
        {
          id: 'web',
          name: 'Web',
          command: 'pnpm dev --port $CONDUCTOR_PORT',
          default: true,
          availableIn: ['local', 'remote']
        },
        { id: 'worker', name: 'Worker', command: 'pnpm worker:dev' },
        { id: 'test', name: 'Test', command: 'pnpm test:watch' },
        {
          id: 'storybook',
          name: 'Storybook',
          command: 'pnpm storybook --port 6006 --no-open',
          cwd: 'packages/ui'
        }
      ],
      runMode: 'concurrent',
      autoRunAfterSetup: true,
      unsupportedFields: []
    })
  })

  it('imports real-repo actions with local-only availability', async () => {
    const candidate = await inspectConductor({
      '.conductor/settings.toml': fixture('conductor-settings-relaticle.toml')
    })
    expect(candidate?.runMode).toBe('concurrent')
    expect(candidate?.run).toEqual([
      {
        id: 'preview',
        name: 'Preview',
        command: 'open "https://$(basename "$PWD").test"',
        default: true,
        availableIn: ['local']
      },
      {
        id: 'horizon',
        name: 'Horizon',
        command: 'bash bin/workspace-queue.sh',
        availableIn: ['local']
      },
      { id: 'vite', name: 'Vite', command: 'pnpm run dev', availableIn: ['local'] }
    ])
  })

  it('reads the legacy string form as one action without rewriting the command', async () => {
    const candidate = await inspectConductor({
      '.conductor/settings.toml':
        '[scripts]\nsetup = "npm install"\nrun = "npm run dev -- --port $CONDUCTOR_PORT"\n'
    })
    expect(candidate).toMatchObject({
      run: [{ id: 'run', name: 'Run', command: 'npm run dev -- --port $CONDUCTOR_PORT' }],
      unsupportedFields: []
    })
  })

  it('lets settings.local.toml override one action field by field and hide another', async () => {
    const candidate = await inspectConductor({
      '.conductor/settings.toml': fixture('conductor-settings-docs-example.toml'),
      '.conductor/settings.local.toml': [
        '[scripts]',
        'run_mode = "nonconcurrent"',
        '[scripts.run.web]',
        'command = "pnpm dev --port 4000"',
        '[scripts.run.worker]',
        'hide = true',
        '[scripts.run.lint]',
        'command = "pnpm lint --watch"',
        ''
      ].join('\n')
    })
    expect(candidate?.files).toEqual(['.conductor/settings.toml', '.conductor/settings.local.toml'])
    expect(candidate?.runMode).toBe('nonconcurrent')
    expect(candidate?.run?.map((action) => action.id)).toEqual(['web', 'test', 'storybook', 'lint'])
    // Fields the local file does not set stay from the shared file.
    expect(candidate?.run?.[0]).toEqual({
      id: 'web',
      name: 'Web',
      command: 'pnpm dev --port 4000',
      default: true,
      availableIn: ['local', 'remote']
    })
  })

  it('lists scripts.run as skipped when every action is hidden', async () => {
    const candidate = await inspectConductor({
      '.conductor/settings.toml':
        '[scripts]\nsetup = "pnpm install"\n[scripts.run.web]\ncommand = "pnpm dev"\nhide = true\n'
    })
    expect(candidate?.run).toBeUndefined()
    expect(candidate?.unsupportedFields).toEqual(['scripts.run'])
  })

  it('drops an action whose args are not strings rather than running it without them', async () => {
    const candidate = await inspectConductor({
      '.conductor/settings.toml': [
        '[scripts]',
        'setup = "pnpm install"',
        '[scripts.run.web]',
        'command = "pnpm dev"',
        'args = [1, 2]',
        '[scripts.run.docs]',
        'command = "pnpm docs"',
        'args = "it\'s here"',
        ''
      ].join('\n')
    })
    expect(candidate?.run).toEqual([
      { id: 'docs', name: 'Docs', command: "pnpm docs 'it'\\''s here'" }
    ])
  })

  it('still needs a setup script: run actions alone are not a candidate', async () => {
    expect(
      await inspectConductor({
        '.conductor/settings.toml': '[scripts.run.web]\ncommand = "pnpm dev"\n'
      })
    ).toBeUndefined()
  })

  it('imports run and runScriptMode from conductor.json', async () => {
    const candidate = await inspectConductor({
      'conductor.json': JSON.stringify({
        scripts: { setup: 'npm install', run: 'npm run dev', archive: 'npm run clean' },
        runScriptMode: 'nonconcurrent'
      })
    })
    expect(candidate).toEqual({
      provider: 'conductor',
      label: 'Conductor',
      files: ['conductor.json'],
      setup: 'npm install',
      archive: 'npm run clean',
      run: [{ id: 'run', name: 'Run', command: 'npm run dev' }],
      runMode: 'nonconcurrent',
      unsupportedFields: []
    })
  })
})

describe('formatSetupScriptImportAsOrcaYaml', () => {
  it('round-trips imported run actions through parseOrcaYaml', async () => {
    const candidate = await inspectConductor({
      '.conductor/settings.toml': fixture('conductor-settings-docs-example.toml')
    })
    if (!candidate) {
      throw new Error('expected a Conductor candidate')
    }
    const text = formatSetupScriptImportAsOrcaYaml(candidate)
    expect(text).toMatchInlineSnapshot(`
      "scripts:
        setup: pnpm install
        archive: pnpm clean
        run:
          web:
            command: pnpm dev --port $CONDUCTOR_PORT
            default: true
            availableIn:
              - local
              - remote
          worker:
            command: pnpm worker:dev
          test:
            command: pnpm test:watch
          storybook:
            command: pnpm storybook --port 6006 --no-open
            cwd: packages/ui
        runMode: concurrent
        autoRunAfterSetup: true
      "
    `)
    expect(parseOrcaYaml(text)?.scripts).toEqual({
      setup: candidate.setup,
      archive: candidate.archive,
      run: candidate.run,
      runMode: candidate.runMode,
      autoRunAfterSetup: candidate.autoRunAfterSetup
    })
  })

  it('writes a bare legacy action as a string and keeps multi-line setup intact', async () => {
    const candidate = await inspectConductor({
      'conductor.json': JSON.stringify({
        scripts: { setup: 'npm install\ncp .env.example .env', run: 'npm run dev' }
      })
    })
    if (!candidate) {
      throw new Error('expected a Conductor candidate')
    }
    const text = formatSetupScriptImportAsOrcaYaml(candidate)
    expect(text).toContain('run: npm run dev')
    expect(parseOrcaYaml(text)?.scripts).toEqual({
      setup: 'npm install\ncp .env.example .env',
      run: candidate.run
    })
  })

  it('writes only setup and archive for candidates without run actions', () => {
    const text = formatSetupScriptImportAsOrcaYaml({
      provider: 'package-manager',
      label: 'pnpm',
      files: ['pnpm-lock.yaml'],
      setup: 'pnpm install'
    })
    expect(text).toBe('scripts:\n  setup: pnpm install\n')
  })
})
