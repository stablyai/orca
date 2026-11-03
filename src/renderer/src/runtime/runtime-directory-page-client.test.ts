import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY } from '../../../shared/files-runtime-capabilities'

const callRuntimeRpc = vi.fn()
const readRuntimeDirectory = vi.fn()
let statuses = new Map<string, unknown>()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('./runtime-file-mutation-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ runtimeStatusByEnvironmentId: statuses }) }
}))

import { readRuntimeDirectoryPage } from './runtime-directory-page-client'

const REMOTE = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/srv/repo'
}
const entry = (name: string) => ({ name, isDirectory: false, isSymlink: false })
const AFTER_A = { name: 'a', isDirectory: false }

function hostWithCapabilities(capabilities: string[]): void {
  statuses = new Map([['env-1', { status: { capabilities } }]])
}

describe('readRuntimeDirectoryPage', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    readRuntimeDirectory.mockReset()
    statuses = new Map()
  })

  it('takes the whole folder from a host that ignored the page fields', async () => {
    hostWithCapabilities([FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY])
    callRuntimeRpc.mockResolvedValueOnce([entry('c'), entry('a'), entry('b')])

    await expect(
      readRuntimeDirectoryPage(REMOTE, '/srv/repo/big', { after: AFTER_A, limit: 1 })
    ).resolves.toEqual({ entries: [entry('b'), entry('c')], total: 3, hasMore: false })
  })
})
