import { expect, it } from 'vitest'
import { searchRuntimeFilePaths, listRuntimeFiles } from './files/search/runtime-file-search-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall
} from './files/runtime-file-client-test-harness'
installRuntimeFileClientEnvironment()

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
