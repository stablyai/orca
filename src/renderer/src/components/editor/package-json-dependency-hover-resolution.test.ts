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
  // Why the renderer supplies it at all: main authorizes this root against its
  // own worktree registration before anything runs in it, so the value is a
  // claim to be checked, never a path to be trusted.
  it('supplies the worktree root its own hover context resolved', async () => {
    const lookupPackageInfo = vi.fn(async () => ({ status: 'not-found' as const }))

    await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion: async () => ({ status: 'installed', version: '19.0.0' }),
      lookupPackageInfo
    })

    expect(lookupPackageInfo).toHaveBeenCalledWith({
      packageName: 'react',
      worktreeRoot: '/repo',
      executionHostId: 'local'
    })
  })

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

  // Orca web has no lookup at all. Nothing known about the package means no
  // hover, rather than a tooltip whose only content is our own limitation.
  it('renders no hover when the lookup is absent and the package is not installed', async () => {
    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion: async () => ({ status: 'not-installed' }),
      lookupPackageInfo: undefined
    })

    expect(result).toBeNull()
  })

  it('still renders the installed version when the lookup is absent', async () => {
    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion: async () => ({ status: 'installed', version: '18.2.0' }),
      lookupPackageInfo: undefined
    })

    expect(result?.markdown).toContain('18.2.0')
    expect(result?.markdown).not.toMatch(/not found|disabled|Could not complete/i)
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

describe('rejects dependency keys that are not valid npm package names', () => {
  // Why: the key comes from a file the user opened, not from us. Without a
  // gate it is concatenated into `node_modules/<key>/package.json`, so a key
  // containing `..` walks out of the worktree and the read still goes through
  // the relay on a remote host. Hovering must never be a filesystem probe.
  it.each([
    ['../../../../etc'],
    ['..'],
    ['foo/../../bar'],
    ['A_CAPITALS_NOT_ALLOWED'],
    ['has space']
  ])('does not read or look up %s', async (packageName) => {
    const resolveInstalledVersion = vi.fn()
    const lookupPackageInfo = vi.fn()

    const result = await resolvePackageJsonDependencyHover({
      modelText: `{ "dependencies": { ${JSON.stringify(packageName)}: "1.0.0" } }`,
      offset: `{ "dependencies": { "`.length + 1,
      isCancelled: () => false,
      resolveContext: () => ({ worktreeId: 'w1', filePath: '/repo/package.json' }) as never,
      resolveInstalledVersion,
      lookupPackageInfo
    } as never)

    expect(resolveInstalledVersion).not.toHaveBeenCalled()
    expect(lookupPackageInfo).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })
})
