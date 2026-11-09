import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectSetupScriptImportCandidates } from './setup-script-imports'

// Fixtures are verbatim copies of public repositories' files (repo named in each file name).
function fixture(name: string): string {
  return readFileSync(
    new URL(`./__fixtures__/setup-script-imports/${name}`, import.meta.url),
    'utf8'
  )
}

function makeReader(files: Record<string, string>) {
  return async (relativePath: string): Promise<string | null> => files[relativePath] ?? null
}

async function inspect(files: Record<string, string>) {
  return inspectSetupScriptImportCandidates(makeReader(files))
}

describe('Conductor settings.toml', () => {
  it('imports setup and archive and lists run actions as skipped', async () => {
    expect(
      await inspect({ '.conductor/settings.toml': fixture('conductor-settings-inbox-zero.toml') })
    ).toEqual([
      {
        provider: 'conductor',
        label: 'Conductor',
        files: ['.conductor/settings.toml'],
        setup: 'pnpm install --prefer-offline --frozen-lockfile',
        archive:
          'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/dev-setup.ts clean',
        unsupportedFields: ['scripts.run']
      }
    ])
  })

  it('reports run_mode alongside run actions', async () => {
    const [candidate] = await inspect({
      '.conductor/settings.toml': fixture('conductor-settings-relaticle.toml')
    })
    expect(candidate).toMatchObject({
      setup: 'bash bin/setup-workspace.sh',
      archive: 'bash bin/archive-workspace.sh',
      unsupportedFields: ['scripts.run', 'scripts.run_mode']
    })
  })

  it('wins over conductor.json and lets settings.local.toml override per key', async () => {
    const candidates = await inspect({
      'conductor.json': JSON.stringify({ scripts: { setup: 'npm install' } }),
      '.conductor/settings.toml': '[scripts]\nsetup = "pnpm install"\narchive = "pnpm clean"\n',
      '.conductor/settings.local.toml':
        '[scripts]\nsetup = """\npnpm install\ncp "$CONDUCTOR_ROOT_PATH/.env" .env\n"""\n'
    })
    expect(candidates).toEqual([
      {
        provider: 'conductor',
        label: 'Conductor',
        files: ['.conductor/settings.toml', '.conductor/settings.local.toml'],
        setup: 'pnpm install\ncp "$CONDUCTOR_ROOT_PATH/.env" .env',
        archive: 'pnpm clean',
        unsupportedFields: []
      }
    ])
  })

  it('falls back to conductor.json when settings.toml is not valid TOML', async () => {
    const [candidate] = await inspect({
      'conductor.json': JSON.stringify({ scripts: { setup: 'npm install' } }),
      '.conductor/settings.toml': '[scripts\nsetup = '
    })
    expect(candidate).toMatchObject({ files: ['conductor.json'], setup: 'npm install' })
  })
})

describe('devcontainer.json', () => {
  it('chains creation-time commands from a commented config and skips per-start ones', async () => {
    expect(
      await inspect({
        '.devcontainer/devcontainer.json': fixture('devcontainer-freecodecamp.jsonc')
      })
    ).toEqual([
      {
        provider: 'devcontainer',
        label: 'Dev Container',
        files: ['.devcontainer/devcontainer.json'],
        setup:
          '.devcontainer/on-create.sh\npnpm install --prefer-offline\n.devcontainer/post-create.sh',
        unsupportedFields: ['postStartCommand', 'postAttachCommand']
      }
    ])
  })

  it('reports features as skipped', async () => {
    const [candidate] = await inspect({
      '.devcontainer.json': fixture('devcontainer-aspire.jsonc')
    })
    expect(candidate).toMatchObject({
      files: ['.devcontainer.json'],
      setup: './restore.sh',
      unsupportedFields: ['postStartCommand', 'features']
    })
  })

  it('reads a BOM-prefixed file and survives pathological nesting elsewhere', async () => {
    const candidates = await inspect({
      '.devcontainer/devcontainer.json': '﻿{ "postCreateCommand": "npm ci" }',
      '.cursor/environment.json': '['.repeat(20_000)
    })
    expect(candidates.map((candidate) => candidate.setup)).toEqual(['npm ci'])
  })

  it('converts argv and parallel object forms, rewriting workspace variables', async () => {
    const [candidate] = await inspect({
      '.devcontainer/devcontainer.json': `{
        // object form: the spec runs these in parallel
        "postCreateCommand": {
          "server": "npm install --prefix \${containerWorkspaceFolder}/server",
          "client": ["npm", "install", "--prefix", "client"],
          "quoted": ["sh", "-c", "echo hi"],
          "token": "npm config set token \${localEnv:NPM_TOKEN:none}",
        },
        "onCreateCommand": ["git", "lfs", "pull"],
      }`
    })
    expect(candidate).toMatchObject({
      setup:
        'git lfs pull\nnpm install --prefix ${ORCA_WORKTREE_PATH}/server\nnpm install --prefix client',
      unsupportedFields: ['postCreateCommand.quoted', 'postCreateCommand.token']
    })
  })
})

describe('Cursor environment.json', () => {
  it('imports install and lists machine settings as skipped', async () => {
    expect(
      await inspect({ '.cursor/environment.json': fixture('cursor-environment-novu.json') })
    ).toEqual([
      {
        provider: 'cursor',
        label: 'Cursor',
        files: ['.cursor/environment.json'],
        setup: 'bash .cursor/scripts/install.sh',
        unsupportedFields: ['start', 'terminals', 'build']
      }
    ])
  })
})

describe('Copilot setup steps', () => {
  it('keeps portable run steps and skips actions, expressions and runner-only steps', async () => {
    const [candidate] = await inspect({
      '.github/workflows/copilot-setup-steps.yml': fixture('copilot-setup-steps-autogpt.yml')
    })
    expect(candidate?.provider).toBe('copilot')
    expect(candidate?.label).toBe('GitHub Copilot')
    expect(candidate?.unsupportedFields).toEqual([
      'steps.1.uses',
      'steps.2.uses',
      'steps.3.run',
      'steps.7.uses',
      'steps.9.run',
      'steps.10.uses',
      'steps.12.run',
      'steps.13.uses',
      'steps.15.uses',
      'steps.16.run'
    ])
    const setup = candidate?.setup.split('\n') ?? []
    expect(setup.slice(0, 4)).toEqual([
      '(',
      'cd autogpt_platform/backend || exit 1',
      'poetry lock',
      'if ! git diff --quiet --ignore-matching-lines="^# " poetry.lock; then'
    ])
    expect(setup).toContain('poetry install')
    expect(setup).toContain('corepack enable')
    expect(setup).toContain('pnpm install --frozen-lockfile')
    expect(setup).toContain('make init-env')
    expect(candidate?.setup).not.toContain('sudo')
    expect(candidate?.setup).not.toContain('GITHUB_')
    expect(candidate?.setup).not.toContain('${{')
  })

  it('isolates each step, applies run defaults and drops conditional steps', async () => {
    const [candidate] = await inspect({
      '.github/workflows/copilot-setup-steps.yml': `
jobs:
  copilot-setup-steps:
    defaults:
      run:
        working-directory: web
    steps:
      - run: cd client && npm ci
      - run: cp "$GITHUB_WORKSPACE/.env.example" .env
      - if: runner.os == 'Linux'
        run: apt-get install -y libvips
      - env:
          TOKEN: abc
        run: npm run fetch-assets
`
    })
    expect(candidate).toMatchObject({
      setup:
        '(\ncd web || exit 1\ncd client && npm ci\n)\n(\ncd web || exit 1\ncp "${ORCA_WORKTREE_PATH}/.env.example" .env\n)',
      unsupportedFields: ['steps.2.if', 'steps.3.env']
    })
  })

  it('ignores workflows without the copilot-setup-steps job', async () => {
    expect(
      await inspect({
        '.github/workflows/copilot-setup-steps.yml':
          'jobs:\n  build:\n    steps:\n      - run: npm ci\n'
      })
    ).toEqual([])
  })
})

describe('Capy setup.json', () => {
  it('imports initialize and lists refresh and commands as skipped', async () => {
    expect(await inspect({ '.capy/setup.json': fixture('capy-setup-jep.json') })).toEqual([
      {
        provider: 'capy',
        label: 'Capy',
        files: ['.capy/setup.json'],
        setup: './scripts/setup.sh',
        unsupportedFields: ['scripts.refresh', 'commands']
      }
    ])
  })
})

describe('import precedence', () => {
  it('ranks tool configs first and disposable-machine setups below the lockfile guess', async () => {
    const candidates = await inspect({
      '.devcontainer/devcontainer.json': '{ "postCreateCommand": "npm ci" }',
      '.github/workflows/copilot-setup-steps.yml':
        'jobs:\n  copilot-setup-steps:\n    steps:\n      - run: npm ci\n',
      'package.json': '{ "packageManager": "pnpm@10.0.0" }',
      '.cursor/environment.json': '{ "install": "npm install" }',
      '.conductor/settings.toml': '[scripts]\nsetup = "pnpm install"\n'
    })
    expect(candidates.map((candidate) => candidate.provider)).toEqual([
      'conductor',
      'cursor',
      'package-manager',
      'copilot',
      'devcontainer'
    ])
  })
})
