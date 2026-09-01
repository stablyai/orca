import { describe, expect, it, vi } from 'vitest'
import { resolvePackageJsonDependencyHover } from './package-json-dependency-hover-resolution'
import type { PackageJsonDependencyHoverContext } from './package-json-dependency-hover-context'

const TEXT = '{\n  "dependencies": {\n    "react": "19.0.0"\n  }\n}\n'
const REACT_KEY_OFFSET = TEXT.indexOf('react') + 1

const CONTEXT: PackageJsonDependencyHoverContext = {
  worktreeRoot: '/repo',
  relativePath: 'package.json',
  filePath: '/repo/package.json',
  worktreeId: 'repo-1::/repo',
  connectionId: null,
  executionHostId: 'local'
}

describe('resolvePackageJsonDependencyHover', () => {
  it('returns null and never resolves context when no dependency key is hovered', async () => {
    const resolveContext = vi.fn()
    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: TEXT.indexOf('19.0.0'),
      isCancelled: () => false,
      resolveContext,
      resolveInstalledVersion: vi.fn(),
      lookupPackageInfo: vi.fn()
    })

    expect(result).toBeNull()
    expect(resolveContext).not.toHaveBeenCalled()
  })

  it('returns null when the hover context cannot be resolved (ambiguous host)', async () => {
    const lookupPackageInfo = vi.fn()
    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => undefined,
      resolveInstalledVersion: vi.fn(),
      lookupPackageInfo
    })

    expect(result).toBeNull()
    expect(lookupPackageInfo).not.toHaveBeenCalled()
  })

  it('checks cancellation after every await and stops without calling later steps', async () => {
    let cancelled = false
    const resolveInstalledVersion = vi.fn(async () => {
      cancelled = true
      return { status: 'not-installed' as const }
    })
    const lookupPackageInfo = vi.fn(async () => ({ status: 'not-found' as const }))

    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => cancelled,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion,
      lookupPackageInfo
    })

    expect(result).toBeNull()
    expect(lookupPackageInfo).not.toHaveBeenCalled()
  })

  it('treats a lookup that resolves to undefined (Orca web) the same as lookup-disabled, keeping the installed version visible', async () => {
    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion: async () => ({ status: 'installed', version: '19.0.0' }),
      lookupPackageInfo: async () => undefined
    })

    expect(result).not.toBeNull()
    expect(result?.markdown).toContain('19.0.0')
  })

  it('renders a full hover result with installed version and range from the located key', async () => {
    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion: async () => ({ status: 'installed', version: '19.0.0' }),
      lookupPackageInfo: async () => ({ status: 'not-found' })
    })

    expect(result).toEqual({
      markdown: expect.stringContaining('19.0.0'),
      startOffset: TEXT.indexOf('"react"'),
      endOffset: TEXT.indexOf('"react"') + '"react"'.length
    })
  })

  it('never calls lookupPackageInfo when it is absent (no crash, no throw)', async () => {
    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion: async () => ({ status: 'not-installed' }),
      lookupPackageInfo: undefined
    })

    expect(result).not.toBeNull()
  })

  describe('catalog handling', () => {
    const CATALOG_TEXT = '{\n  "catalog": {\n    "react": "19.0.0"\n  }\n}\n'
    const CATALOG_REACT_KEY_OFFSET = CATALOG_TEXT.indexOf('react') + 1

    it('resolves a dependency declared inside a catalog block through the same pipeline', async () => {
      const result = await resolvePackageJsonDependencyHover({
        modelText: CATALOG_TEXT,
        offset: CATALOG_REACT_KEY_OFFSET,
        isCancelled: () => false,
        resolveContext: () => CONTEXT,
        resolveInstalledVersion: async () => ({ status: 'installed', version: '19.0.0' }),
        lookupPackageInfo: async () => ({ status: 'not-found' })
      })

      expect(result).toEqual({
        markdown: expect.stringContaining('19.0.0'),
        startOffset: CATALOG_TEXT.indexOf('"react"'),
        endOffset: CATALOG_TEXT.indexOf('"react"') + '"react"'.length
      })
    })

    it('resolves a dependency whose version spec is the literal "catalog:" identically to a directly-versioned dependency, never branching on the spec text', async () => {
      const catalogSpecText = '{\n  "dependencies": {\n    "react": "catalog:"\n  }\n}\n'
      const offset = catalogSpecText.indexOf('react') + 1
      const resolveInstalledVersion = vi.fn(async () => ({
        status: 'installed' as const,
        version: '19.0.0'
      }))
      const lookupPackageInfo = vi.fn(async () => ({ status: 'not-found' as const }))

      const result = await resolvePackageJsonDependencyHover({
        modelText: catalogSpecText,
        offset,
        isCancelled: () => false,
        resolveContext: () => CONTEXT,
        resolveInstalledVersion,
        lookupPackageInfo
      })

      expect(result).not.toBeNull()
      // Why: pins that only the dependency key drives resolution — the pipeline
      // never reads the version-spec string, so `catalog:` never reaches
      // `resolveInstalledVersion`/`lookupPackageInfo` or the rendered markdown.
      expect(resolveInstalledVersion).toHaveBeenCalledWith(CONTEXT, 'react')
      expect(lookupPackageInfo).toHaveBeenCalledWith({
        packageName: 'react',
        worktreeRoot: CONTEXT.worktreeRoot,
        executionHostId: CONTEXT.executionHostId
      })
      expect(result?.markdown).not.toContain('catalog:')
    })
  })
})
