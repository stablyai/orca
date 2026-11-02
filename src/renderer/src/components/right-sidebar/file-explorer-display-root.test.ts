import { describe, expect, it } from 'vitest'
import {
  getCollapsedExplorerBreadcrumbs,
  getExplorerBreadcrumbs,
  getExplorerDirectoryDepth,
  getExplorerDisplayDepth,
  getExplorerDisplayRootOptions,
  getExplorerDisplayRootPath,
  getExplorerParentPath,
  getExplorerWatchedWorkspacePath,
  isExplorerRootOutsideWorkspace,
  getExplorerEffectiveExpanded
} from './file-explorer-display-root'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import { fileExplorerEntriesToTreeNodes } from './file-explorer-directory-listing'

const flags = { ignoredSet: new Set<string>(), showDotfiles: true, showGitIgnoredFiles: true }

describe('sparse explorer projection', () => {
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

  it('resolves an outside browsing root without workspace-relative depth', () => {
    expect(getExplorerDisplayRootPath('/repo', '/', '/tmp/reference')).toBe('/tmp/reference')
    expect(getExplorerDisplayDepth('/repo', '/tmp/reference')).toBe(0)
    expect(isExplorerRootOutsideWorkspace('/repo', '/tmp/reference')).toBe(true)
    expect(isExplorerRootOutsideWorkspace('/repo', '/repo/docs')).toBe(false)
  })

  it.each([
    [
      '/Users/dev/reference',
      [
        { label: '/', path: '/' },
        { label: 'Users', path: '/Users' },
        { label: 'dev', path: '/Users/dev' },
        { label: 'reference', path: '/Users/dev/reference' }
      ]
    ],
    [
      'C:\\Users\\dev',
      [
        { label: 'C:\\', path: 'C:\\' },
        { label: 'Users', path: 'C:\\Users' },
        { label: 'dev', path: 'C:\\Users\\dev' }
      ]
    ],
    [
      '\\\\server\\share\\docs',
      [
        { label: '\\\\server\\share', path: '\\\\server\\share' },
        { label: 'docs', path: '\\\\server\\share\\docs' }
      ]
    ],
    [
      '/tmp/a\\b',
      [
        { label: '/', path: '/' },
        { label: 'tmp', path: '/tmp' },
        { label: 'a\\b', path: '/tmp/a\\b' }
      ]
    ]
  ])('builds clickable breadcrumb ancestors for %s', (path, expected) => {
    expect(getExplorerBreadcrumbs(path)).toEqual(expected)
  })

  it('returns the parent without navigating above a filesystem root', () => {
    expect(getExplorerParentPath('/Users/dev')).toBe('/Users')
    expect(getExplorerParentPath('/')).toBe('/')
    expect(getExplorerParentPath('C:\\Users')).toBe('C:\\')
    expect(getExplorerParentPath('C:\\')).toBe('C:\\')
  })

  it('collapses intermediate breadcrumbs for paths exceeding maximum visible count', () => {
    const full = getExplorerBreadcrumbs('/private/tmp/repo/src')
    expect(full).toHaveLength(5)
    expect(getCollapsedExplorerBreadcrumbs(full)).toEqual([
      { label: '/', path: '/' },
      { label: '…', path: '/private/tmp/repo' },
      { label: 'src', path: '/private/tmp/repo/src' }
    ])

    const shortCrumbs = getExplorerBreadcrumbs('/Users/dev')
    expect(getCollapsedExplorerBreadcrumbs(shortCrumbs)).toEqual(shortCrumbs)
  })

  it('computes expanded-directory depth from the workspace or an outside display root', () => {
    expect(getExplorerDirectoryDepth('/repo', '/repo/packages/app', '/repo/packages/app/src')).toBe(
      2
    )
    expect(getExplorerDirectoryDepth('/repo', '/tmp/reference', '/tmp/reference/src')).toBe(0)
    expect(getExplorerDirectoryDepth('/repo', '/tmp/reference', '/tmp/reference/src/lib')).toBe(1)
  })

  it('computes every depth from an ancestor display root while browsing above the workspace', () => {
    expect(getExplorerDirectoryDepth('/home/dev/repo', '/home/dev', '/home/dev/repo')).toBe(0)
    expect(getExplorerDirectoryDepth('/home/dev/repo', '/home/dev', '/home/dev/repo/src')).toBe(1)
  })

  it('keeps watching the workspace while an outside ancestor still shows it', () => {
    expect(getExplorerWatchedWorkspacePath('/home/dev/repo', '/home/dev/repo/src')).toBe(
      '/home/dev/repo'
    )
    expect(getExplorerWatchedWorkspacePath('/home/dev/repo', '/home/dev')).toBe('/home/dev/repo')
    expect(getExplorerWatchedWorkspacePath('/home/dev/repo', '/tmp/reference')).toBeNull()
    expect(getExplorerWatchedWorkspacePath(null, '/home/dev')).toBeNull()
  })
})
