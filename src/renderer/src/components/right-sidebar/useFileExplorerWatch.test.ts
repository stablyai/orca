import { describe, expect, it } from 'vitest'
import {
  canonicalizeFileExplorerWatchPath,
  getFileExplorerWatchRuntimeEnvironmentId,
  getExternalFileChangeRelativePath,
  resolveCachedDirPath
} from './useFileExplorerWatch'
import type { AppState } from '@/store/types'

describe('getExternalFileChangeRelativePath', () => {
  it('treats isDirectory=undefined as a file so delete events still notify', () => {
    // Deleted paths cannot report isDirectory; undefined must still invalidate editor contents.
    expect(
      getExternalFileChangeRelativePath('/repo', '/repo/config/settings.json', undefined)
    ).toBe('config/settings.json')
  })

  it('rejects sibling worktrees whose path merely shares a prefix', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo-other/file.ts', false)).toBeNull()
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
  it('matches Windows cache keys case-insensitively (#10264)', () => {
    const cache = { 'C:\\Repo\\src': { children: [] } }
    expect(resolveCachedDirPath(cache, 'c:\\repo\\src')).toBe('C:\\Repo\\src')
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

  // Runtime rows are stamped as they land, so focus is never ownership evidence for an unowned row.
  it('never routes an unowned worktree through the focused runtime', () => {
    expect(
      getFileExplorerWatchRuntimeEnvironmentId(
        makeState({ activeRuntimeEnvironmentId: 'focused-runtime' }),
        'wt-1'
      )
    ).toBeNull()
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
