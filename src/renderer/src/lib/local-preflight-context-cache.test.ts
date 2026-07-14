import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  _getProjectRuntimePreflightContextCacheSizeForTest,
  _getWslPreflightContextCacheSizeForTest,
  _hasProjectRuntimePreflightContextCacheEntryForTest,
  _hasWslPreflightContextCacheEntryForTest,
  getLocalPreflightContext,
  resetLocalPreflightContextCachesForTests
} from './local-preflight-context'

const WSL_CACHE_LIMIT = 128
const PROJECT_RUNTIME_CACHE_LIMIT = 2048

afterEach(() => {
  resetLocalPreflightContextCachesForTests()
})

function makeWslState(distro: string): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    repos: [{ id: 'repo-1', path: `\\\\wsl.localhost\\${distro}\\home\\alice\\repo` }],
    worktreesByRepo: {}
  } as AppState
}

function makeWindowsProjectState(projectId: string): AppState {
  return {
    activeRepoId: projectId,
    activeWorktreeId: null,
    repos: [{ id: projectId, path: `C:\\Users\\alice\\${projectId}` }],
    settings: {},
    worktreesByRepo: {}
  } as AppState
}

describe('local preflight context caches', () => {
  it('releases an old WSL selector snapshot after sustained context churn', () => {
    const first = getLocalPreflightContext(makeWslState('Distro0'), 'darwin')

    for (let index = 1; index <= WSL_CACHE_LIMIT; index += 1) {
      getLocalPreflightContext(makeWslState(`Distro${index}`), 'darwin')
    }

    expect(getLocalPreflightContext(makeWslState('Distro0'), 'darwin')).not.toBe(first)
  })

  it('caps cached WSL distro snapshots', () => {
    for (let index = 0; index < WSL_CACHE_LIMIT + 1; index++) {
      const distro = `Distro${index}`
      expect(getLocalPreflightContext(makeWslState(distro), 'darwin')).toEqual({
        wslDistro: distro
      })
    }

    expect(_getWslPreflightContextCacheSizeForTest()).toBe(WSL_CACHE_LIMIT)
    expect(_hasWslPreflightContextCacheEntryForTest('Distro0')).toBe(false)
    expect(_hasWslPreflightContextCacheEntryForTest(`Distro${WSL_CACHE_LIMIT}`)).toBe(true)
  })

  it('caps cached project runtime snapshots without mutating order on reads', () => {
    for (let index = 0; index < PROJECT_RUNTIME_CACHE_LIMIT; index++) {
      getLocalPreflightContext(makeWindowsProjectState(`project-${index}`), 'win32')
    }

    getLocalPreflightContext(makeWindowsProjectState('project-0'), 'win32')
    getLocalPreflightContext(
      makeWindowsProjectState(`project-${PROJECT_RUNTIME_CACHE_LIMIT}`),
      'win32'
    )

    expect(_getProjectRuntimePreflightContextCacheSizeForTest()).toBe(PROJECT_RUNTIME_CACHE_LIMIT)
    expect(
      _hasProjectRuntimePreflightContextCacheEntryForTest('project-0:windows-host:global-default')
    ).toBe(false)
    expect(
      _hasProjectRuntimePreflightContextCacheEntryForTest('project-1:windows-host:global-default')
    ).toBe(true)
  })
})
