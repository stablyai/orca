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
})
