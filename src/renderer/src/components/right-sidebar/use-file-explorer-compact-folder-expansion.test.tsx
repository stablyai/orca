// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirCache, TreeNode } from './file-explorer-types'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import {
  getCompactFolderExpansionStep,
  useFileExplorerCompactFolderExpansion
} from './use-file-explorer-compact-folder-expansion'

const store = vi.hoisted(() => {
  const state: { expandedDirs: Record<string, Set<string>> } = { expandedDirs: {} }
  return state
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

afterEach(cleanup)
beforeEach(() => {
  store.expandedDirs = {}
})

function row(relativePath: string, isDirectory: boolean): TreeNode {
  return {
    name: relativePath.split('/').at(-1) ?? relativePath,
    path: `/repo/${relativePath}`,
    relativePath,
    isDirectory,
    depth: relativePath.split('/').length - 1
  }
}

function listings(childrenByPath: Record<string, TreeNode[]>): Record<string, DirCache> {
  const dirCache: Record<string, DirCache> = {}
  for (const [path, children] of Object.entries(childrenByPath)) {
    dirCache[path] = { children }
  }
  return dirCache
}

function explorerState(dirCache: Record<string, DirCache>, expanded: Set<string>) {
  return {
    rowProjection: createVisibleFileExplorerRowProjection(
      { dirCache, expanded, worktreePath: '/repo' },
      { ignoredSet: new Set(), showDotfiles: true, showGitIgnoredFiles: true, compactFolders: true }
    ),
    expanded,
    loadingDirPaths: new Set<string>(),
    dirCache
  }
}

describe('getCompactFolderExpansionStep', () => {
  it('opens the only child folder once the opened folder has loaded', () => {
    const state = explorerState(
      listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)]
      }),
      new Set(['/repo/com'])
    )

    expect(getCompactFolderExpansionStep('/repo/com', state)).toEqual({
      kind: 'open-next',
      dirPath: '/repo/com/example'
    })
  })

  it('waits while the opened folder is still being read', () => {
    const state = explorerState(listings({ '/repo': [row('com', true)] }), new Set(['/repo/com']))

    expect(getCompactFolderExpansionStep('/repo/com', state)).toEqual({ kind: 'wait' })
    expect(
      getCompactFolderExpansionStep('/repo/com', {
        ...state,
        dirCache: { ...state.dirCache, '/repo/com': { children: [] } },
        loadingDirPaths: new Set(['/repo/com'])
      })
    ).toEqual({ kind: 'wait' })
  })

  it('stops at a folder whose listing is not a single folder', () => {
    const state = explorerState(
      listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true), row('com/README.md', false)]
      }),
      new Set(['/repo/com'])
    )

    expect(getCompactFolderExpansionStep('/repo/com', state)).toEqual({ kind: 'done' })
  })

  it('stops once the folder has been closed again', () => {
    const state = explorerState(
      listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)]
      }),
      new Set()
    )

    expect(getCompactFolderExpansionStep('/repo/com', state)).toEqual({ kind: 'done' })
  })

  it('steps from a folded folder to the next folder of the same row', () => {
    const state = explorerState(
      listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)],
        '/repo/com/example': [row('com/example/app', true)]
      }),
      new Set(['/repo/com', '/repo/com/example'])
    )

    expect(getCompactFolderExpansionStep('/repo/com', state)).toEqual({
      kind: 'open-next',
      dirPath: '/repo/com/example'
    })
    expect(getCompactFolderExpansionStep('/repo/com/example', state)).toEqual({
      kind: 'open-next',
      dirPath: '/repo/com/example/app'
    })
  })
})

describe('useFileExplorerCompactFolderExpansion', () => {
  function renderExpansion(enabled: boolean) {
    const toggleDir = vi.fn((worktreeId: string, dirPath: string) => {
      const next = new Set(store.expandedDirs[worktreeId] ?? [])
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      store.expandedDirs = { ...store.expandedDirs, [worktreeId]: next }
    })
    const hook = renderHook(
      ({ dirCache, expanded }: { dirCache: Record<string, DirCache>; expanded: Set<string> }) =>
        useFileExplorerCompactFolderExpansion({
          enabled,
          activeWorktreeId: 'wt',
          toggleDir,
          ...explorerState(dirCache, expanded)
        }),
      {
        initialProps: {
          dirCache: listings({ '/repo': [row('com', true)] }),
          expanded: new Set<string>()
        }
      }
    )
    const toggledPaths = (): string[] => toggleDir.mock.calls.map(([, dirPath]) => dirPath)
    return { hook, toggledPaths }
  }

  it('opens each single child folder as its parent listing arrives', () => {
    const { hook, toggledPaths } = renderExpansion(true)

    act(() => hook.result.current('wt', '/repo/com'))
    hook.rerender({
      dirCache: listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)]
      }),
      expanded: new Set(['/repo/com'])
    })
    hook.rerender({
      dirCache: listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)],
        '/repo/com/example': [row('com/example/app', true)]
      }),
      expanded: new Set(['/repo/com', '/repo/com/example'])
    })
    hook.rerender({
      dirCache: listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)],
        '/repo/com/example': [row('com/example/app', true)],
        '/repo/com/example/app': [
          row('com/example/app/Main.java', false),
          row('com/example/app/ui', true)
        ]
      }),
      expanded: new Set(['/repo/com', '/repo/com/example', '/repo/com/example/app'])
    })

    expect(toggledPaths()).toEqual(['/repo/com', '/repo/com/example', '/repo/com/example/app'])
  })

  it('keeps opening the chain when a render from before the click commits after it', () => {
    const { hook, toggledPaths } = renderExpansion(true)

    act(() => hook.result.current('wt', '/repo/com'))
    // This render started before the click, so its expanded set does not have com yet.
    hook.rerender({
      dirCache: listings({ '/repo': [row('com', true)] }),
      expanded: new Set()
    })
    hook.rerender({
      dirCache: listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)]
      }),
      expanded: new Set(['/repo/com'])
    })

    expect(toggledPaths()).toEqual(['/repo/com', '/repo/com/example'])
  })

  it('opens only the clicked folder while compact folders is off', () => {
    const { hook, toggledPaths } = renderExpansion(false)

    act(() => hook.result.current('wt', '/repo/com'))
    hook.rerender({
      dirCache: listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)]
      }),
      expanded: new Set(['/repo/com'])
    })

    expect(toggledPaths()).toEqual(['/repo/com'])
  })

  it('does not reopen a chain the user closed before its listing arrived', () => {
    const { hook, toggledPaths } = renderExpansion(true)

    act(() => hook.result.current('wt', '/repo/com'))
    act(() => hook.result.current('wt', '/repo/com'))
    hook.rerender({
      dirCache: listings({
        '/repo': [row('com', true)],
        '/repo/com': [row('com/example', true)]
      }),
      expanded: new Set()
    })

    expect(toggledPaths()).toEqual(['/repo/com', '/repo/com'])
    expect(store.expandedDirs.wt.size).toBe(0)
  })
})
