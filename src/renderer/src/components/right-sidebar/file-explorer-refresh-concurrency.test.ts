import { describe, expect, it } from 'vitest'
import { fileExplorerRefreshConcurrency } from './file-explorer-refresh-concurrency'

describe('fileExplorerRefreshConcurrency', () => {
  it('allows the widest fan-out for local disk reads', () => {
    expect(fileExplorerRefreshConcurrency({ kind: 'local' })).toBe(16)
  })

  it('caps SSH-owned worktrees at the remote tier', () => {
    expect(fileExplorerRefreshConcurrency({ kind: 'ssh', connectionId: 'target-1' })).toBe(4)
  })

  it('treats an SSH-backed runtime as remote', () => {
    expect(
      fileExplorerRefreshConcurrency({
        kind: 'runtime',
        environmentId: 'env-1',
        executionHostId: 'ssh:target-1'
      })
    ).toBe(4)
  })

  it('uses the runtime tier for a non-SSH runtime host', () => {
    expect(
      fileExplorerRefreshConcurrency({
        kind: 'runtime',
        environmentId: 'env-1',
        executionHostId: 'runtime:env-1'
      })
    ).toBe(8)
  })

  it('falls back to the conservative remote tier when ownership is unresolved', () => {
    expect(fileExplorerRefreshConcurrency({ kind: 'unresolved' })).toBe(4)
  })
})
