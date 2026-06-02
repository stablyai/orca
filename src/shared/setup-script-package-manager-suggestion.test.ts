import { describe, expect, it } from 'vitest'
import { inspectSetupScriptImportCandidates } from './setup-script-imports'

function makeReader(files: Record<string, string>) {
  return async (relativePath: string): Promise<string | null> => files[relativePath] ?? null
}

describe('package manager setup script suggestions', () => {
  it('suggests setup commands from package manager lockfiles', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
        'pnpm-lock.yaml': 'lockfileVersion: 9.0'
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'package-manager',
        label: 'package manager',
        files: ['pnpm-lock.yaml'],
        setup: 'pnpm install',
        unsupportedFields: []
      }
    ])
  })

  it('uses packageManager when no lockfile is present', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'package.json': JSON.stringify({ packageManager: 'bun@1.2.0' })
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'package-manager',
        label: 'package manager',
        files: ['package.json'],
        setup: 'bun install',
        unsupportedFields: []
      }
    ])
  })

  it('uses explicit packageManager over conflicting lockfiles', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'package.json': JSON.stringify({ packageManager: 'pnpm@9.15.0' }),
        'package-lock.json': '{}'
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'package-manager',
        label: 'package manager',
        files: ['package.json'],
        setup: 'pnpm install',
        unsupportedFields: []
      }
    ])
  })

  it('does not check lockfiles when packageManager declares the setup command', async () => {
    const fileExistsCalls: string[] = []
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'package.json': JSON.stringify({ packageManager: 'pnpm@9.15.0' })
      }),
      {
        fileExists: async (relativePath) => {
          fileExistsCalls.push(relativePath)
          return true
        }
      }
    )

    expect(fileExistsCalls).toEqual([])
    expect(candidates).toEqual([
      {
        provider: 'package-manager',
        label: 'package manager',
        files: ['package.json'],
        setup: 'pnpm install',
        unsupportedFields: []
      }
    ])
  })

  it('uses file existence checks instead of reading lockfile contents', async () => {
    const readCalls: string[] = []
    const fileExistsCalls: string[] = []
    const candidates = await inspectSetupScriptImportCandidates(
      async (relativePath) => {
        readCalls.push(relativePath)
        return relativePath === 'package.json' ? JSON.stringify({ scripts: { dev: 'vite' } }) : null
      },
      {
        fileExists: async (relativePath) => {
          fileExistsCalls.push(relativePath)
          return relativePath === 'pnpm-lock.yaml'
        }
      }
    )

    expect(readCalls).not.toContain('pnpm-lock.yaml')
    expect(fileExistsCalls).toContain('pnpm-lock.yaml')
    expect(candidates).toContainEqual({
      provider: 'package-manager',
      label: 'package manager',
      files: ['pnpm-lock.yaml'],
      setup: 'pnpm install',
      unsupportedFields: []
    })
  })

  it('does not suggest a package-manager setup without a valid package.json', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'package.json': '{',
        'pnpm-lock.yaml': 'lockfileVersion: 9.0'
      })
    )

    expect(candidates).toEqual([])
  })

  it('does not guess between multiple lockfiles without packageManager', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
        'pnpm-lock.yaml': 'lockfileVersion: 9.0',
        'package-lock.json': '{}'
      })
    )

    expect(candidates).toEqual([])
  })

  it('allows multiple lockfiles for the same package manager family', async () => {
    const candidates = await inspectSetupScriptImportCandidates(
      makeReader({
        'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
        'package-lock.json': '{}',
        'npm-shrinkwrap.json': '{}'
      })
    )

    expect(candidates).toEqual([
      {
        provider: 'package-manager',
        label: 'package manager',
        files: ['package-lock.json'],
        setup: 'npm install',
        unsupportedFields: []
      }
    ])
  })
})
