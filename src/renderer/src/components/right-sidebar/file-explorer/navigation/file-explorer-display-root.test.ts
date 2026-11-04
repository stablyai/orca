import { describe, expect, it } from 'vitest'
import {
  getCollapsedExplorerBreadcrumbs,
  getExplorerBreadcrumbs,
  getExplorerDisplayDepth,
  getExplorerDisplayRootPath,
  getExplorerParentPath,
  getExplorerWatchedWorkspacePath,
  isExplorerRootOutsideWorkspace
} from './file-explorer-display-root'

describe('explorer roots outside the workspace', () => {
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

  it('keeps watching the workspace while an outside ancestor still shows it', () => {
    expect(getExplorerWatchedWorkspacePath('/home/dev/repo', '/home/dev/repo/src')).toBe(
      '/home/dev/repo'
    )
    expect(getExplorerWatchedWorkspacePath('/home/dev/repo', '/home/dev')).toBe('/home/dev/repo')
    expect(getExplorerWatchedWorkspacePath('/home/dev/repo', '/tmp/reference')).toBeNull()
    expect(getExplorerWatchedWorkspacePath(null, '/home/dev')).toBeNull()
  })
})
