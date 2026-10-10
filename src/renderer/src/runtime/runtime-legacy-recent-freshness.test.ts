import { expect, it } from 'vitest'
import { listRuntimeFiles } from './runtime-file-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall
} from './runtime-file-client-test-harness'
installRuntimeFileClientEnvironment()
for (const version of [1, 2]) {
  it(`refreshes candidate eligibility after deletion on version ${version}`, async () => {
    let files = [{ relativePath: 'src/recent.ts', basename: 'recent.ts', kind: 'text' }]
    runtimeEnvironmentCall.mockImplementation(({ method }) =>
      Promise.resolve({
        id: 'fresh',
        ok: true,
        _meta: { runtimeId: 'host' },
        result:
          method === 'files.searchPaths'
            ? { files: [], truncated: false, quickOpenSearchVersion: version }
            : {
                worktree: 'freshness',
                rootPath: '/host/repo',
                files: [...files],
                totalCount: files.length,
                truncated: false
              }
      })
    )
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: `freshness-${version}`,
      worktreePath: '/host/repo'
    }
    const options = { rootPath: '/host/repo', candidatePaths: ['src/recent.ts'], maxResults: 1 }
    expect(await listRuntimeFiles(context, options)).toEqual(['src/recent.ts'])
    files = []
    expect(await listRuntimeFiles(context, options)).toEqual([])
    expect(
      runtimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'files.list')
    ).toHaveLength(2)
  })
}
