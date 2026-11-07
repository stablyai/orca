import { describe, expect, it, vi } from 'vitest'
import { buildExcludePathPrefixes } from './quick-open-filter'

// Model Vite’s throwing node:path browser stub: named member imports once white-screened renderer startup (#15158).
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
})
