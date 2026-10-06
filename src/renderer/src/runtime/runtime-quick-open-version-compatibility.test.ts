import { expect, it, vi } from 'vitest'
import { searchRuntimeFilePaths, listRuntimeFiles } from './runtime-file-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  fsListFiles
} from './runtime-file-client-test-harness'
installRuntimeFileClientEnvironment()

it('accepts a future compatible search version rather than falling back on exact-version inequality', async () => {
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'compat',
    ok: true,
    _meta: { runtimeId: 'host' },
    result: {
      files: [{ relativePath: 'apps/late/.env' }],
      truncated: false,
      quickOpenSearchVersion: 4
    }
  })
  await expect(
    searchRuntimeFilePaths(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'future-host',
        worktreePath: '/host/repo'
      },
      { query: '.env late' }
    )
  ).resolves.toEqual({ files: ['apps/late/.env'], truncated: false })
  expect(runtimeEnvironmentCall).toHaveBeenCalledOnce()
})

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
        settings: { activeRuntimeEnvironmentId: 'env-1' },
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

it('sends bounded candidates only after a compatible host advertises their semantics', async () => {
  runtimeEnvironmentCall.mockImplementation(({ method }) =>
    Promise.resolve({
      id: 'compat',
      ok: true,
      _meta: { runtimeId: 'host' },
      result:
        method === 'files.searchPaths'
          ? { files: [], truncated: false, quickOpenSearchVersion: 3 }
          : ['src/recent.ts']
    })
  )
  await expect(
    listRuntimeFiles(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'recent-new',
        worktreePath: '/host/repo'
      },
      { rootPath: '/host/repo', candidatePaths: ['src/recent.ts'], maxResults: 1 }
    )
  ).resolves.toEqual(['src/recent.ts'])
  expect(runtimeEnvironmentCall.mock.calls[1][0]).toMatchObject({
    method: 'files.listAll',
    params: { worktree: 'id:recent-new', candidatePaths: ['src/recent.ts'], maxResults: 1 }
  })
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
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'recent-truncated',
        worktreePath: '/host/repo'
      },
      { rootPath: '/host/repo', candidatePaths: ['src/recent.ts'], maxResults: 1 }
    )
  ).rejects.toThrow('inventory limit')
  expect(fsListFiles).not.toHaveBeenCalled()
})

it.each(['missing-search', 'old-search'] as const)(
  'translates only unavailable inventory errors after %s',
  async (route) => {
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'fallback-errors',
      worktreePath: '/host/repo'
    }
    for (const code of ['method_not_found', 'forbidden', 'remote_runtime_unavailable']) {
      runtimeEnvironmentCall.mockImplementation(({ method }) =>
        Promise.resolve({
          id: 'compat',
          _meta: { runtimeId: 'host' },
          ...(method === 'files.searchPaths' && route === 'old-search'
            ? { ok: true, result: { files: [], truncated: false, quickOpenSearchVersion: 1 } }
            : {
                ok: false,
                error: {
                  code: method === 'files.searchPaths' ? 'method_not_found' : code,
                  message: 'inventory failed'
                }
              })
        })
      )
      const search = searchRuntimeFilePaths(context, { query: 'two terms' })
      await (route === 'old-search'
        ? expect(search).resolves.toEqual({ files: [], truncated: false })
        : expect(search).rejects.toThrow(
            code === 'method_not_found' ? 'Update the remote host' : 'inventory failed'
          ))
    }
  }
)

it('preserves raw errors when joining a cached pending legacy inventory', async () => {
  const context = {
    settings: { activeRuntimeEnvironmentId: 'env-1' },
    worktreeId: 'cached-errors',
    worktreePath: '/host/repo'
  }
  const inventory = Promise.withResolvers<unknown>()
  runtimeEnvironmentCall.mockImplementation(({ method }) =>
    method === 'files.list'
      ? inventory.promise
      : Promise.resolve({
          id: 'compat',
          ok: false,
          _meta: { runtimeId: 'host' },
          error: { code: 'method_not_found', message: 'search unavailable' }
        })
  )
  const first = searchRuntimeFilePaths(context, { query: 'two terms' })
  const translated = expect(first).rejects.toThrow('Update the remote host')
  await vi.waitFor(() =>
    expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toContain(
      'files.list'
    )
  )
  const cached = searchRuntimeFilePaths(context, { query: 'other terms' })
  const raw = expect(cached).rejects.toThrow('raw cached failure')
  inventory.resolve({
    id: 'compat',
    ok: false,
    _meta: { runtimeId: 'host' },
    error: { code: 'method_not_found', message: 'raw cached failure' }
  })
  await Promise.all([translated, raw])
  expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)).toEqual([
    'files.searchPaths',
    'files.list'
  ])
})

it.each(['method_not_found', 'file_inventory_capacity', 'remote_runtime_unavailable'])(
  'does not require optional inventory to return existing old-host punctuation matches (%s)',
  async (code) => {
    runtimeEnvironmentCall.mockImplementation(({ method }) =>
      Promise.resolve({
        id: 'compat',
        _meta: { runtimeId: 'host' },
        ...(method === 'files.searchPaths'
          ? {
              ok: true,
              result: {
                rootPath: '/host/repo',
                files: [{ relativePath: 'late/package-lock.json' }],
                truncated: false,
                quickOpenSearchVersion: 1
              }
            }
          : { ok: false, error: { code, message: 'inventory unavailable' } })
      })
    )
    await expect(
      searchRuntimeFilePaths(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: `punctuation-${code}`,
          worktreePath: '/host/repo'
        },
        { query: 'package-lock' }
      )
    ).resolves.toEqual({ files: ['late/package-lock.json'], truncated: false })
    expect(runtimeEnvironmentCall).toHaveBeenCalledOnce()
  }
)

it.each([{ includeIgnored: false }, { followSymlinks: true }])(
  'uses discovery preferences on a version-two paired host: %j',
  async (options) => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'compat',
      _meta: { runtimeId: 'host' },
      ok: true,
      result: {
        rootPath: '/repo',
        files: [{ relativePath: 'src/file.ts' }],
        truncated: false,
        quickOpenSearchVersion: 2
      }
    })
    await expect(
      searchRuntimeFilePaths(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'v2-options',
          worktreePath: '/repo'
        },
        { query: 'file', ...options }
      )
    ).resolves.toEqual({ files: ['src/file.ts'], truncated: false })
  }
)

it('keeps inherited ignored-file visibility from disabling an older paired host', async () => {
  runtimeEnvironmentCall.mockImplementation(({ method }) =>
    Promise.resolve({
      id: 'compat',
      _meta: { runtimeId: 'host' },
      ok: true,
      result:
        method === 'files.listAll'
          ? ['src/file.ts']
          : {
              rootPath: '/repo',
              files: [{ relativePath: 'src/file.ts' }],
              truncated: false,
              quickOpenSearchVersion: 1
            }
    })
  )
  const context = {
    settings: { activeRuntimeEnvironmentId: 'env-1' },
    worktreeId: 'legacy-ignored',
    worktreePath: '/repo'
  }
  await expect(
    searchRuntimeFilePaths(context, {
      query: 'file',
      includeIgnored: false,
      allowLegacyIncludeIgnored: true
    })
  ).resolves.toEqual({ files: ['src/file.ts'], truncated: false })
  await expect(
    listRuntimeFiles(context, {
      rootPath: '/repo',
      includeIgnored: false,
      allowLegacyIncludeIgnored: true
    })
  ).resolves.toEqual(['src/file.ts'])
  expect(runtimeEnvironmentCall.mock.calls.at(-1)?.[0].params).not.toHaveProperty('includeIgnored')
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
    settings: { activeRuntimeEnvironmentId: 'env-1' },
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
