import { describe, expect, it } from 'vitest'
import {
  deriveWorkspaceRootPath,
  isLocalTypeScriptWorkspaceConnection,
  isTypeScriptWorkspaceFilePath,
  isTypeScriptWorkspaceLanguage
} from './monaco-typescript-workspace-model-policy'
import { getWorkspacePackageAliasModelPath } from './monaco-typescript-package-alias-path'

describe('isTypeScriptWorkspaceLanguage', () => {
  it('limits workspace model hydration to TypeScript worker languages', () => {
    expect(isTypeScriptWorkspaceLanguage('typescript')).toBe(true)
    expect(isTypeScriptWorkspaceLanguage('javascript')).toBe(true)
    expect(isTypeScriptWorkspaceLanguage('json')).toBe(false)
  })
})

describe('isTypeScriptWorkspaceFilePath', () => {
  it('accepts TypeScript and JavaScript source paths', () => {
    expect(isTypeScriptWorkspaceFilePath('/repo/src/index.ts')).toBe(true)
    expect(isTypeScriptWorkspaceFilePath('/repo/src/view.tsx')).toBe(true)
    expect(isTypeScriptWorkspaceFilePath('/repo/src/types.d.ts')).toBe(true)
    expect(isTypeScriptWorkspaceFilePath('/repo/src/index.mjs')).toBe(true)
  })

  it('skips generated and dependency directories', () => {
    expect(isTypeScriptWorkspaceFilePath('/repo/node_modules/pkg/index.d.ts')).toBe(false)
    expect(isTypeScriptWorkspaceFilePath('/repo/dist/index.js')).toBe(false)
    expect(isTypeScriptWorkspaceFilePath('/repo/.turbo/cache/file.ts')).toBe(false)
  })
})

describe('deriveWorkspaceRootPath', () => {
  it('prefers a containing worktree path', () => {
    expect(
      deriveWorkspaceRootPath({
        filePath: '/repo/workspace/app/src/index.ts',
        relativePath: 'workspace/app/src/index.ts',
        worktreePath: '/repo'
      })
    ).toBe('/repo')
  })

  it('derives the root from a file path and relative path when needed', () => {
    expect(
      deriveWorkspaceRootPath({
        filePath: '/repo/apps/api/src/service.ts',
        relativePath: 'apps/api/src/service.ts'
      })
    ).toBe('/repo')
  })

  it('derives the root when the file path uses Windows separators the relative path does not', () => {
    expect(
      deriveWorkspaceRootPath({
        filePath: 'C:\\repo\\apps\\api\\src\\service.ts',
        relativePath: 'apps/api/src/service.ts'
      })
    ).toBe('C:\\repo')
  })
})

describe('isLocalTypeScriptWorkspaceConnection', () => {
  it('allows a confirmed-local file', () => {
    expect(isLocalTypeScriptWorkspaceConnection(null)).toBe(true)
  })

  it('blocks a file owned by a remote SSH connection', () => {
    expect(isLocalTypeScriptWorkspaceConnection('ssh-target-1')).toBe(false)
  })

  it('blocks a file whose connection has not resolved yet, rather than assuming local', () => {
    expect(isLocalTypeScriptWorkspaceConnection(undefined)).toBe(false)
  })
})

describe('getWorkspacePackageAliasModelPath', () => {
  it('maps files inside any discovered workspace package to a node_modules alias model', () => {
    const packageAliases = new Map([
      [
        'modules/domain-lib',
        {
          name: '@acme/domain-lib',
          directory: 'modules/domain-lib',
          entryPaths: ['/repo/modules/domain-lib/src/index.ts']
        }
      ]
    ])

    expect(
      getWorkspacePackageAliasModelPath({
        rootPath: '/repo',
        relativePath: 'modules/domain-lib/src/nested/value.ts',
        packageAliases
      })
    ).toBe('/repo/node_modules/@acme/domain-lib/src/nested/value.ts')
  })

  it('does not assume a package lives under apps, packages, or tools', () => {
    expect(
      getWorkspacePackageAliasModelPath({
        rootPath: '/repo',
        relativePath: 'apps/api/src/index.ts',
        packageAliases: new Map()
      })
    ).toBeNull()
  })
})
