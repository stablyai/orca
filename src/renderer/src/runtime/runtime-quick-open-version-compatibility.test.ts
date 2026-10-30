import { expect, it } from 'vitest'
import { searchRuntimeFilePaths, listRuntimeFiles } from './runtime-file-search-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  fsListFiles
} from './runtime-file-client-test-harness'
installRuntimeFileClientEnvironment()

it('validates default-policy recent paths on a version-two host through complete legacy inventory', async () => {
  runtimeEnvironmentCall.mockImplementation(({ method }) =>
    Promise.resolve({
      id: 'compat',
      ok: true,
      _meta: { runtimeId: 'host' },
      result:
        method === 'files.searchPaths'
          ? { files: [], truncated: false, quickOpenSearchVersion: 2 }
          : {
              worktree: 'id:recent-legacy',
              rootPath: '/host/repo',
              files: [{ relativePath: 'src/recent.ts', basename: 'recent.ts', kind: 'text' }],
              totalCount: 1,
              truncated: false
            }
    })
  )
  await expect(
    listRuntimeFiles(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'recent-legacy',
        worktreePath: '/host/repo'
      },
      { rootPath: '/host/repo', candidatePaths: ['src/recent.ts', 'src/deleted.ts'], maxResults: 2 }
    )
  ).resolves.toEqual(['src/recent.ts'])
  expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
    'files.searchPaths',
    'files.list'
  ])
  expect(fsListFiles).not.toHaveBeenCalled()
})

it('refuses to infer recent eligibility from a truncated old-host inventory', async () => {
  runtimeEnvironmentCall.mockImplementation(({ method }) =>
    Promise.resolve({
      id: 'compat',
      ok: true,
      _meta: { runtimeId: 'host' },
      result:
        method === 'files.searchPaths'
          ? { files: [], truncated: false, quickOpenSearchVersion: 2 }
          : {
              worktree: 'id:recent-truncated',
              rootPath: '/host/repo',
              files: [],
              totalCount: 1,
              truncated: true
            }
    })
  )
  await expect(
    listRuntimeFiles(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'recent-truncated',
        worktreePath: '/host/repo'
      },
      { rootPath: '/host/repo', candidatePaths: ['src/recent.ts'], maxResults: 1 }
    )
  ).rejects.toThrow('inventory limit')
  expect(fsListFiles).not.toHaveBeenCalled()
})

it('does not reuse unfiltered recent inventory after enabling supported ignore filtering', async () => {
  runtimeEnvironmentCall.mockImplementation(({ method }) =>
    Promise.resolve({
      id: 'compat',
      _meta: { runtimeId: 'host' },
      ok: true,
      result:
        method === 'files.list'
          ? {
              worktree: 'id:cached-v2-options',
              rootPath: '/repo',
              files: [{ relativePath: 'secret.ts', basename: 'secret.ts', kind: 'text' }],
              totalCount: 1,
              truncated: false
            }
          : { rootPath: '/repo', files: [], truncated: false, quickOpenSearchVersion: 2 }
    })
  )
  const context = {
    target: { kind: 'environment' as const, environmentId: 'env-1' },
    worktreeId: 'cached-v2-options',
    worktreePath: '/repo'
  }
  await expect(
    listRuntimeFiles(context, { rootPath: '/repo', candidatePaths: ['secret.ts'], maxResults: 1 })
  ).resolves.toEqual(['secret.ts'])
  await expect(
    searchRuntimeFilePaths(context, {
      query: 'secret',
      includeIgnored: false,
      allowLegacyIncludeIgnored: true
    })
  ).resolves.toEqual({ files: [], truncated: false })
  expect(runtimeEnvironmentCall.mock.calls.at(-1)?.[0]).toMatchObject({
    method: 'files.searchPaths',
    params: { includeIgnored: false }
  })
})
