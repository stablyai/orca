import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRecipeInheritedEnv,
  isCredentialLikeEnvName,
  isRecipeEnvNamePassed,
  listCredentialLikeEnvNames,
  parseRecipePassEnv
} from './ephemeral-vm-recipe-env'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'
import { parseOrcaYaml } from './orca-yaml'

const tmpRoots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('isCredentialLikeEnvName', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'NPM_TOKEN',
    'STRIPE_SECRET',
    'DB_PASSWORD',
    'AWS_ACCESS_KEY_ID',
    'AWS_PROFILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'AZURE_CLIENT_SECRET',
    'github_pat',
    'SSH_AUTH_SOCK'
  ])('flags %s', (name) => {
    expect(isCredentialLikeEnvName(name)).toBe(true)
  })

  it.each([
    'PATH',
    'HOME',
    'SHELL',
    'LANG',
    'KEYCHAIN_PATH',
    'TERM_PROGRAM',
    'NODE_ENV',
    'TOKENIZERS'
  ])('does not flag %s', (name) => {
    expect(isCredentialLikeEnvName(name)).toBe(false)
  })
})

describe('isRecipeEnvNamePassed', () => {
  it('passes everything when passEnv is not set', () => {
    expect(isRecipeEnvNamePassed('OPENAI_API_KEY', undefined)).toBe(true)
  })

  it('passes the base set, exact names and trailing-* prefixes', () => {
    const passEnv = ['GH_TOKEN', 'CLOUDSDK_*']
    expect(isRecipeEnvNamePassed('PATH', passEnv, 'linux')).toBe(true)
    expect(isRecipeEnvNamePassed('LC_MESSAGES', passEnv, 'linux')).toBe(true)
    expect(isRecipeEnvNamePassed('GH_TOKEN', passEnv, 'linux')).toBe(true)
    expect(isRecipeEnvNamePassed('CLOUDSDK_CORE_PROJECT', passEnv, 'linux')).toBe(true)
    expect(isRecipeEnvNamePassed('GITHUB_TOKEN', passEnv, 'linux')).toBe(false)
    expect(isRecipeEnvNamePassed('gh_token', passEnv, 'linux')).toBe(false)
    expect(isRecipeEnvNamePassed('path', passEnv, 'linux')).toBe(false)
  })

  it('matches names case-insensitively on Windows', () => {
    expect(isRecipeEnvNamePassed('Path', [], 'win32')).toBe(true)
    expect(isRecipeEnvNamePassed('SystemRoot', [], 'win32')).toBe(true)
    expect(isRecipeEnvNamePassed('gh_token', ['GH_TOKEN'], 'win32')).toBe(true)
  })
})

describe('buildRecipeInheritedEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    OPENAI_API_KEY: 'sk-x',
    GH_TOKEN: 'gh-x',
    AWS_REGION: 'us-east-1'
  }

  it('copies the full environment without passEnv', () => {
    expect(buildRecipeInheritedEnv(source, undefined, 'linux')).toEqual(source)
  })

  it('keeps only the base set and listed names with passEnv', () => {
    expect(buildRecipeInheritedEnv(source, ['GH_TOKEN', 'AWS_*'], 'linux')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GH_TOKEN: 'gh-x',
      AWS_REGION: 'us-east-1'
    })
    expect(buildRecipeInheritedEnv(source, [], 'linux')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me'
    })
  })
})

describe('listCredentialLikeEnvNames', () => {
  it('returns sorted names with values, never values', () => {
    expect(
      listCredentialLikeEnvNames({
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-x',
        EMPTY_TOKEN: '',
        ANTHROPIC_API_KEY: 'sk-y'
      })
    ).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
  })
})

describe('parseRecipePassEnv', () => {
  it('accepts names and prefixes, dropping duplicates', () => {
    expect(parseRecipePassEnv(['GH_TOKEN', ' AWS_* ', 'GH_TOKEN'])).toEqual(['GH_TOKEN', 'AWS_*'])
    expect(parseRecipePassEnv([])).toEqual([])
  })

  it.each([['GH_TOKEN=x'], 'GH_TOKEN', [1], ['A*B'], ['']])('rejects %j', (value) => {
    expect(parseRecipePassEnv(value)).toBeNull()
  })
})

describe('orca.yaml passEnv', () => {
  const recipeYaml = (passEnv: string): string =>
    [
      'environmentRecipes:',
      '  - id: remote-vm',
      '    name: Remote VM',
      '    create: ./create.sh',
      ...(passEnv ? [`    passEnv: ${passEnv}`] : [])
    ].join('\n')

  it('parses a passEnv list onto the recipe', () => {
    expect(parseOrcaYaml(recipeYaml('[GH_TOKEN, "AWS_*"]'))?.environmentRecipes).toEqual([
      {
        id: 'remote-vm',
        name: 'Remote VM',
        create: './create.sh',
        passEnv: ['GH_TOKEN', 'AWS_*']
      }
    ])
  })

  it('leaves passEnv unset when omitted', () => {
    expect(parseOrcaYaml(recipeYaml(''))?.environmentRecipes?.[0]).not.toHaveProperty('passEnv')
  })

  it('keeps a recipe with a malformed passEnv but limits it to the base environment', () => {
    const hooks = parseOrcaYaml(recipeYaml('GH_TOKEN'))
    expect(hooks?.environmentRecipes?.[0]?.passEnv).toEqual([])
    expect(hooks?.environmentRecipeDiagnostics).toEqual([
      expect.objectContaining({ index: 0, field: 'passEnv' })
    ])
  })
})

describe('runRecipeCommand passEnv', () => {
  async function runAndReadEnv(passEnv?: string[]): Promise<Record<string, string>> {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-recipe-env-'))
    tmpRoots.push(repoPath)
    const scriptPath = join(repoPath, 'print-env.js')
    writeFileSync(scriptPath, 'process.stdout.write(JSON.stringify(process.env))\n')
    const result = await runRecipeCommand({
      command: `"${process.execPath}" "${scriptPath}"`,
      repoPath,
      context: { recipeId: 'remote-vm', repoPath },
      mode: 'create',
      resultSchemaVersion: 1,
      ...(passEnv ? { passEnv } : {})
    })
    expect(result.exitCode).toBe(0)
    return JSON.parse(result.stdout)
  }

  it('passes the full environment by default and only the allowlist with passEnv', async () => {
    vi.stubEnv('ORCA_TEST_RECIPE_API_KEY', 'secret-value')
    vi.stubEnv('ORCA_TEST_RECIPE_ALLOWED', 'allowed-value')

    const full = await runAndReadEnv()
    expect(full.ORCA_TEST_RECIPE_API_KEY).toBe('secret-value')

    const limited = await runAndReadEnv(['ORCA_TEST_RECIPE_ALLOWED'])
    expect(limited.ORCA_TEST_RECIPE_API_KEY).toBeUndefined()
    expect(limited.ORCA_TEST_RECIPE_ALLOWED).toBe('allowed-value')
    // Orca's own recipe variables are always set.
    expect(limited.ORCA_VM_MODE).toBe('create')
    expect(limited.ORCA_RECIPE_ID).toBe('remote-vm')
  })
})
