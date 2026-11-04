import { describe, expect, it } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createVisibleFileExplorerRowProjection,
  getFileExplorerIgnoredQueryRelativePaths
} from './useFileExplorerVisibleRowProjection'

function row(relativePath: string, isDirectory = false, depth?: number): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory,
    depth: depth ?? relativePath.split('/').length - 1
  }
}

function cache(childrenByPath: Record<string, TreeNode[]>): Record<string, DirCache> {
  const dirCache: Record<string, DirCache> = {}
  for (const [path, children] of Object.entries(childrenByPath)) {
    dirCache[path] = { children }
  }
  return dirCache
}

describe('file explorer rows outside the workspace', () => {
  it('judges outside dotfiles relative to the browsed root, not absolute ancestors', () => {
    const outsideRow = (name: string): TreeNode => ({
      name,
      path: `/home/dev/.config/app/${name}`,
      relativePath: `/home/dev/.config/app/${name}`,
      isDirectory: false,
      depth: 0
    })
    const treeInput = {
      dirCache: cache({
        '/home/dev/.config/app': [outsideRow('settings.json'), outsideRow('.secret')]
      }),
      displayRootPath: '/home/dev/.config/app',
      expanded: new Set<string>(),
      worktreePath: '/repo'
    }
    const projection = createVisibleFileExplorerRowProjection(treeInput, {
      ignoredSet: new Set(),
      showDotfiles: false,
      showGitIgnoredFiles: true
    })

    expect(projection.getVisibleSlice(0, 10).map((entry) => entry.name)).toEqual(['settings.json'])
  })

  it('queries git ignored paths only for rows inside the workspace', () => {
    const workspaceNode = row('src/index.ts')
    const outsideNode: TreeNode = {
      name: 'notes.md',
      path: '/home/dev/notes.md',
      relativePath: '/home/dev/notes.md',
      isDirectory: false,
      depth: 0
    }
    const treeInput = {
      dirCache: cache({ '/home/dev': [outsideNode], '/repo': [workspaceNode] }),
      displayRootPath: '/home/dev',
      expanded: new Set(['/repo']),
      worktreePath: '/repo'
    }

    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, true)).toEqual([])
  })

  it('still reaches workspace descendants while browsing an expanded ancestor', () => {
    const outsideDir: TreeNode = {
      name: 'dev',
      path: '/home/dev',
      relativePath: '/home/dev',
      isDirectory: true,
      depth: 0
    }
    const workspaceRoot: TreeNode = {
      name: 'repo',
      path: '/home/dev/repo',
      relativePath: '',
      isDirectory: true,
      depth: 1
    }
    const workspaceFile: TreeNode = {
      name: 'index.ts',
      path: '/home/dev/repo/index.ts',
      relativePath: 'index.ts',
      isDirectory: false,
      depth: 2
    }
    const treeInput = {
      dirCache: cache({
        '/home': [outsideDir],
        '/home/dev': [workspaceRoot],
        '/home/dev/repo': [workspaceFile]
      }),
      displayRootPath: '/home',
      expanded: new Set(['/home/dev', '/home/dev/repo']),
      worktreePath: '/home/dev/repo'
    }

    expect(getFileExplorerIgnoredQueryRelativePaths(treeInput, true)).toEqual(['index.ts'])
  })
})
