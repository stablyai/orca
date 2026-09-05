// @vitest-environment happy-dom
import { typescript as monacoTS } from 'monaco-editor'
import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceCompilerOptions,
  cacheWorkspacePackageResolution,
  readWorkspacePackageAliases
} from './monaco-typescript-package-alias-resolution'
import type { WorkspacePackageAlias } from './monaco-typescript-package-alias-path'

function packageAlias(rootPath: string, name: string, directory: string): WorkspacePackageAlias {
  return {
    name,
    directory,
    entryPaths: [`${rootPath}/${directory}/src/index.ts`]
  }
}

describe('workspace compiler option isolation', () => {
  it('does not leak a previous workspace baseUrl/paths into one with no aliases', () => {
    const workspaceA = '/repo/workspace-a'
    const workspaceB = '/repo/workspace-b'

    cacheWorkspacePackageResolution({
      rootPath: workspaceA,
      packageAliases: new Map([
        ['packages/lib-a', packageAlias(workspaceA, '@acme/lib-a', 'packages/lib-a')]
      ])
    })
    applyWorkspaceCompilerOptions(workspaceA)
    expect(monacoTS.typescriptDefaults.getCompilerOptions().baseUrl).toBe(workspaceA)
    expect(monacoTS.typescriptDefaults.getCompilerOptions().paths?.['@acme/lib-a']).toBeDefined()

    // Workspace B has no package aliases at all.
    cacheWorkspacePackageResolution({ rootPath: workspaceB, packageAliases: new Map() })
    applyWorkspaceCompilerOptions(workspaceB)

    const optionsForB = monacoTS.typescriptDefaults.getCompilerOptions()
    expect(optionsForB.baseUrl).not.toBe(workspaceA)
    expect(optionsForB.paths?.['@acme/lib-a']).toBeUndefined()
  })

  it('reapplies a workspace already-hydrated aliases when switching back to it', () => {
    const workspaceA = '/repo/workspace-a2'
    const workspaceB = '/repo/workspace-b2'

    cacheWorkspacePackageResolution({
      rootPath: workspaceA,
      packageAliases: new Map([
        ['packages/lib-a', packageAlias(workspaceA, '@acme/lib-a2', 'packages/lib-a')]
      ])
    })
    applyWorkspaceCompilerOptions(workspaceA)

    cacheWorkspacePackageResolution({
      rootPath: workspaceB,
      packageAliases: new Map([
        ['packages/lib-b', packageAlias(workspaceB, '@acme/lib-b2', 'packages/lib-b')]
      ])
    })
    applyWorkspaceCompilerOptions(workspaceB)
    expect(monacoTS.typescriptDefaults.getCompilerOptions().baseUrl).toBe(workspaceB)

    // Switch focus back to the already-hydrated workspace A.
    applyWorkspaceCompilerOptions(workspaceA)
    const optionsForA = monacoTS.typescriptDefaults.getCompilerOptions()
    expect(optionsForA.baseUrl).toBe(workspaceA)
    expect(optionsForA.paths?.['@acme/lib-a2']).toBeDefined()
    expect(optionsForA.paths?.['@acme/lib-b2']).toBeUndefined()
  })

  it('maps an exports subpath to its exact target, not a name-mirrored wildcard guess', async () => {
    const rootPath = '/repo/workspace-exports'
    const packageJsonPath = `${rootPath}/packages/lib-c/package.json`
    window.api = {
      fs: {
        readFile: async ({ filePath }: { filePath: string }) => {
          if (filePath !== packageJsonPath) {
            throw new Error(`unexpected read: ${filePath}`)
          }
          return {
            isBinary: false,
            content: JSON.stringify({
              name: '@acme/lib-c',
              exports: { '.': './src/index.ts', './runtime': './src/browser.ts' }
            })
          }
        }
      }
    } as never

    const packageAliases = await readWorkspacePackageAliases({
      rootPath,
      packageJsonPaths: [packageJsonPath]
    })
    cacheWorkspacePackageResolution({ rootPath, packageAliases })
    applyWorkspaceCompilerOptions(rootPath)

    const options = monacoTS.typescriptDefaults.getCompilerOptions()
    expect(options.paths?.['@acme/lib-c/runtime']).toEqual(['packages/lib-c/src/browser.ts'])
  })
})
