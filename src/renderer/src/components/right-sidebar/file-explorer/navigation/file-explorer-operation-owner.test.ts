import { describe, expect, it, vi } from 'vitest'
import { supportsFileExplorerRootNavigation } from './file-explorer-operation-owner'

vi.mock('@/store/index', () => ({ useAppStore: { getState: vi.fn() } }))

describe('supportsFileExplorerRootNavigation', () => {
  it('supports local and WSL-local filesystem owners but not SSH or remote runtimes', () => {
    expect(supportsFileExplorerRootNavigation({ kind: 'local' })).toBe(true)
    expect(supportsFileExplorerRootNavigation({ kind: 'ssh', connectionId: 'ssh-1' })).toBe(false)
    expect(
      supportsFileExplorerRootNavigation({
        kind: 'runtime',
        environmentId: 'env-1',
        executionHostId: 'runtime:env-1'
      })
    ).toBe(false)
    expect(supportsFileExplorerRootNavigation({ kind: 'unresolved' })).toBe(false)
  })
})
