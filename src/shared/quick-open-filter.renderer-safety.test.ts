import { describe, expect, it, vi } from 'vitest'
import { buildExcludePathPrefixes, shouldExcludeQuickOpenRelPath } from './quick-open-filter'

// Mirrors Vite's `__vite-browser-external` stub, which is what `node:path` resolves to in the
// renderer: reading any member throws. #15158 pulled this module into the renderer graph while it
// still used named imports, which resolve at module evaluation — the app white-screened before
// React mounted. Anything the renderer can reach must therefore not touch `node:path` members.
vi.mock('node:path', () => {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === 'symbol' || key === '__esModule' || key === 'then') {
          return undefined
        }
        throw new Error(
          `Module "node:path" has been externalized for browser compatibility. Cannot access "node:path.${String(key)}" in client code.`
        )
      }
    }
  )
})

describe('quick-open-filter renderer safety', () => {
  it('builds nested-worktree exclude prefixes on a posix root', () => {
    expect(
      buildExcludePathPrefixes('/tmp/repo', ['/tmp/repo/nested', '/tmp/repo/deep/child'])
    ).toEqual(['nested', 'deep/child'])
  })

  it('builds nested-worktree exclude prefixes on a windows root', () => {
    expect(buildExcludePathPrefixes('C:\\Repo', ['c:\\repo\\nested'])).toEqual(['nested'])
    expect(
      buildExcludePathPrefixes('\\\\Server\\Share\\Repo', ['//server/share/repo/nested'])
    ).toEqual(['nested'])
  })

  it('drops stale exclude paths outside the root', () => {
    expect(buildExcludePathPrefixes('/tmp/repo', ['/tmp/old-worktree'])).toEqual([])
    expect(buildExcludePathPrefixes('C:\\repo', ['D:\\old-worktree'])).toEqual([])
  })

  it('filters listed paths against those prefixes', () => {
    const prefixes = buildExcludePathPrefixes('/tmp/repo', ['/tmp/repo/nested'])

    expect(shouldExcludeQuickOpenRelPath('nested/src/index.ts', prefixes)).toBe(true)
    expect(shouldExcludeQuickOpenRelPath('src/index.ts', prefixes)).toBe(false)
  })
})
