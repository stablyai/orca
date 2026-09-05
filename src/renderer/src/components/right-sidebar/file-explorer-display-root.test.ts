import { describe, expect, it } from 'vitest'
import {
  getExplorerDisplayDepth,
  getExplorerDisplayRootOptions,
  getExplorerDisplayRootPath,
  resolveExplorerDisplayRootChoice,
  getExplorerEffectiveExpanded
} from './file-explorer-display-root'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import { fileExplorerEntriesToTreeNodes } from './file-explorer-directory-listing'

const flags = { ignoredSet: new Set<string>(), showDotfiles: true, showGitIgnoredFiles: true }

describe('sparse explorer projection', () => {
  it('resolves defaults and preserves explicit full root', () => {
    const options = getExplorerDisplayRootOptions({
      isSparse: true,
      sparseDirectories: ['packages/app', 'packages/api']
    })
    expect(resolveExplorerDisplayRootChoice(options)).toBe('packages/app')
    expect(resolveExplorerDisplayRootChoice(options, '/')).toBe('/')
    expect(resolveExplorerDisplayRootChoice(options, 'removed')).toBe('packages/app')
    expect(getExplorerDisplayRootOptions({ sparseDirectories: ['src'] })).toBeNull()
    expect(resolveExplorerDisplayRootChoice(null, 'src')).toBe('/')
  })
  it('rejects unsafe directories and deduplicates normalized options', () => {
    expect(
      getExplorerDisplayRootOptions({
        isSparse: true,
        sparseDirectories: [
          '/etc',
          '../src',
          'app/../etc',
          'C:\\src',
          'packages\\app',
          'packages/app'
        ]
      })?.map((option) => option.value)
    ).toEqual(['/', 'packages/app'])
  })
  it.each(['/repo', 'C:\\repo'])(
    'keeps identity and depths relative to true root on %s',
    (root) => {
      const scope = getExplorerDisplayRootPath(root, 'packages/app')!
      const depth = getExplorerDisplayDepth(root, scope)
      const children = fileExplorerEntriesToTreeNodes(
        [{ name: 'index.ts', isDirectory: false, isSymlink: false }],
        scope,
        depth - 1,
        root,
        { kind: 'local' }
      )
      const projection = createVisibleFileExplorerRowProjection(
        {
          worktreePath: root,
          displayRootPath: scope,
          expanded: new Set(),
          dirCache: { [scope]: { children } }
        },
        flags
      )
      expect(projection.getRowAtIndex(0)).toMatchObject({
        relativePath: 'packages/app/index.ts',
        depth: 2
      })
      expect(projection.getRowAtIndex(0)?.path).toBe(
        getExplorerDisplayRootPath(root, 'packages/app/index.ts')
      )
    }
  )
  it('scopes name results without duplicating their directory prefix or matching adjacent names', () => {
    const projection = createVisibleFileExplorerRowProjection(
      {
        worktreePath: '/repo',
        displayRootPath: '/repo/packages/app',
        expanded: new Set(),
        dirCache: {}
      },
      {
        ...flags,
        nameFilter: {
          query: 'index',
          relativePaths: [
            'packages/app/src/index.ts',
            'packages/apple/index.ts',
            'packages/api/index.ts'
          ]
        }
      }
    )
    expect(projection.getOrderedPaths()).toEqual([
      '/repo/packages/app/src',
      '/repo/packages/app/src/index.ts'
    ])
    expect(projection.getRowAtIndex(1)?.relativePath).toBe('packages/app/src/index.ts')
  })
  it('keeps the displayed root refreshable after Collapse All without persisting expansion', () => {
    const userExpanded = new Set<string>()
    expect([...getExplorerEffectiveExpanded(userExpanded, '/repo/packages/app')]).toEqual([
      '/repo/packages/app'
    ])
    expect(userExpanded.size).toBe(0)
    expect(getExplorerEffectiveExpanded(userExpanded, null)).toBe(userExpanded)
  })
})
