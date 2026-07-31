import { beforeEach, describe, expect, it, vi } from 'vitest'

const getConnectionIdForFile = vi.fn<() => string | null | undefined>()
const getState = vi.fn<() => { settings: { activeRuntimeEnvironmentId: string | null } }>()

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: (...args: unknown[]) =>
    getConnectionIdForFile(...(args as [])) as string | null | undefined
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => getState() } }))

const { resolveSqliteFileOwner } = await import('./sqlite-file-owner')

beforeEach(() => {
  getConnectionIdForFile.mockReset()
  getState.mockReset()
  getState.mockReturnValue({ settings: { activeRuntimeEnvironmentId: null } })
})

describe('resolveSqliteFileOwner', () => {
  it('reports a local file as local', () => {
    getConnectionIdForFile.mockReturnValue(null)
    expect(resolveSqliteFileOwner('wt-1', '/repo/a.db')).toEqual({ kind: 'local' })
  })

  it('reports an SSH-owned file as remote', () => {
    getConnectionIdForFile.mockReturnValue('ssh-target-1')
    expect(resolveSqliteFileOwner('wt-1', '/repo/a.db')).toEqual({
      kind: 'remote',
      connectionId: 'ssh-target-1'
    })
  })

  it('reports an unresolved owner instead of assuming local', () => {
    getConnectionIdForFile.mockReturnValue(undefined)
    expect(resolveSqliteFileOwner('wt-1', '/repo/a.db')).toEqual({ kind: 'unresolved' })
  })

  it('reports a runtime environment before consulting the connection', () => {
    getState.mockReturnValue({ settings: { activeRuntimeEnvironmentId: 'env-9' } })
    getConnectionIdForFile.mockReturnValue(null)
    expect(resolveSqliteFileOwner('wt-1', '/repo/a.db')).toEqual({ kind: 'runtime-environment' })
    expect(getConnectionIdForFile).not.toHaveBeenCalled()
  })
})
