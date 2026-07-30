import { describe, expect, it } from 'vitest'
import {
  canonicalizeFileExplorerWatchPath,
  getFileExplorerWatchRuntimeEnvironmentId,
  getExternalFileChangeRelativePath,
  resolveCachedDirPath
} from './useFileExplorerWatch'
import type { AppState } from '@/store/types'

describe('getExternalFileChangeRelativePath', () => {
  it('returns a worktree-relative file path for external file updates', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo/config/settings.json', false)).toBe(
      'config/settings.json'
    )
  })

  it('ignores directory events so only file tabs reload', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo/config', true)).toBeNull()
  })

  it('treats isDirectory=undefined as a file so delete events still notify', () => {
    // Why: delete events from the watcher arrive with isDirectory=undefined
    // because the path no longer exists on disk (design §4.4). Gating on
    // `isDirectory !== true` ensures the editor is still notified so stale
    // tab contents get invalidated.
    expect(
      getExternalFileChangeRelativePath('/repo', '/repo/config/settings.json', undefined)
    ).toBe('config/settings.json')
  })

  it('normalizes Windows separators before deriving the relative path', () => {
    expect(
      getExternalFileChangeRelativePath('C:\\repo', 'C:\\repo\\config\\settings.json', false)
    ).toBe('config/settings.json')
  })

  it('matches Windows paths case-insensitively before deriving the relative path', () => {
    expect(
      getExternalFileChangeRelativePath('C:\\Repo', 'c:\\repo\\config\\settings.json', false)
    ).toBe('config/settings.json')
  })

  it('preserves UNC roots when deriving the relative path', () => {
    expect(
      getExternalFileChangeRelativePath(
        '//Server/Share/Repo',
        '//server/share/repo/config/settings.json',
        false
      )
    ).toBe('config/settings.json')
  })

  it('ignores paths outside the active worktree', () => {
    expect(
      getExternalFileChangeRelativePath('/repo', '/other/config/settings.json', false)
    ).toBeNull()
  })

  it('rejects sibling worktrees whose path merely shares a prefix', () => {
    // Why: string-prefix checks without a trailing separator would match
    // `/repo-other/...` as if it were inside `/repo`, leaking events across
    // worktrees.
    expect(getExternalFileChangeRelativePath('/repo', '/repo-other/file.ts', false)).toBeNull()
  })

  it('returns null when the changed path is the worktree root itself', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo', false)).toBeNull()
  })

  it('tolerates a trailing slash on the worktree path', () => {
    expect(getExternalFileChangeRelativePath('/repo/', '/repo/src/index.ts', false)).toBe(
      'src/index.ts'
    )
  })

  it('preserves nested segments in the returned relative path', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo/a/b/c/deep.ts', false)).toBe(
      'a/b/c/deep.ts'
    )
  })
})

describe('canonicalizeFileExplorerWatchPath', () => {
  it('returns event paths with the watched worktree casing for UNC cache lookups', () => {
    expect(
      canonicalizeFileExplorerWatchPath('//Server/Share/Repo', '//server/share/repo/src/index.ts')
    ).toBe('//Server/Share/Repo/src/index.ts')
  })

  it('preserves the watched worktree separator style for Windows cache lookups', () => {
    expect(canonicalizeFileExplorerWatchPath('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe(
      'C:\\Repo\\src\\index.ts'
    )
  })

  it('rejects sibling UNC shares whose path merely shares a prefix', () => {
    expect(
      canonicalizeFileExplorerWatchPath(
        '//Server/Share/Repo',
        '//server/share/repository/src/index.ts'
      )
    ).toBeNull()
  })
})

describe('resolveCachedDirPath', () => {
  it('returns the exact cache key when present', () => {
    const cache = { '/repo/src': { children: [] } }
    expect(resolveCachedDirPath(cache, '/repo/src')).toBe('/repo/src')
  })

  it('matches Windows cache keys case-insensitively (#10264)', () => {
    const cache = { 'C:\\Repo\\src': { children: [] } }
    expect(resolveCachedDirPath(cache, 'c:\\repo\\src')).toBe('C:\\Repo\\src')
  })

  it('falls back to the worktree root path when the root is not yet cached', () => {
    expect(resolveCachedDirPath({}, 'C:\\Repo', 'C:\\Repo')).toBe('C:\\Repo')
  })

  it('returns null when the directory is not cached and is not the worktree root', () => {
    expect(resolveCachedDirPath({ '/repo': { children: [] } }, '/repo/src', '/repo')).toBeNull()
  })
})

describe('getFileExplorerWatchRuntimeEnvironmentId', () => {
  function makeState(args: {
    activeRuntimeEnvironmentId?: string | null
    executionHostId?: AppState['repos'][number]['executionHostId']
    connectionId?: string | null
  }): Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo'> {
    return {
      settings: {
        activeRuntimeEnvironmentId: args.activeRuntimeEnvironmentId ?? null
      } as AppState['settings'],
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: args.connectionId ?? null,
          executionHostId: args.executionHostId
        }
      ],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo/worktree'
          } as AppState['worktreesByRepo'][string][number]
        ]
      }
    }
  }

  it('uses the active runtime for legacy unowned active worktrees', () => {
    expect(
      getFileExplorerWatchRuntimeEnvironmentId(
        makeState({ activeRuntimeEnvironmentId: 'focused-runtime' }),
        'wt-1'
      )
    ).toBe('focused-runtime')
  })

  it('uses the explicit runtime owner when another host is focused', () => {
    expect(
      getFileExplorerWatchRuntimeEnvironmentId(
        makeState({
          activeRuntimeEnvironmentId: 'focused-runtime',
          executionHostId: 'runtime:owner-runtime'
        }),
        'wt-1'
      )
    ).toBe('owner-runtime')
  })

  it('keeps explicitly local active worktrees local when a runtime is focused', () => {
    expect(
      getFileExplorerWatchRuntimeEnvironmentId(
        makeState({
          activeRuntimeEnvironmentId: 'focused-runtime',
          executionHostId: 'local'
        }),
        'wt-1'
      )
    ).toBeNull()
  })

  it('disables a cached watch when its listing owner no longer matches', () => {
    expect(
      getFileExplorerWatchRuntimeEnvironmentId(
        makeState({
          activeRuntimeEnvironmentId: 'focused-runtime',
          executionHostId: 'runtime:owner-runtime'
        }),
        'wt-1',
        {
          kind: 'runtime',
          environmentId: 'old-owner-runtime',
          executionHostId: 'runtime:old-owner-runtime'
        }
      )
    ).toBeUndefined()
  })
})
