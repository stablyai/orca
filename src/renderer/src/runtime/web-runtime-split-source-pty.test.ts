import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  notifyHostTabSplitRefused,
  readHostPublishedSplitSourcePtyId
} from './web-runtime-split-source-pty'

const TAB = 'web-terminal-host-tab-1'
const SOURCE = { worktreeId: 'worktree-1', tabId: TAB, leafId: 'leaf-1' }

const mocks = vi.hoisted(() => {
  const owner: { environmentId: string | null; transport: string } = {
    environmentId: 'env-1',
    transport: 'ready'
  }
  return { owner, toastError: vi.fn() }
})

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({
      terminalLayoutsByTabId: {
        'web-terminal-host-tab-1': { ptyIdsByLeafId: { 'leaf-1': 'remote:env-1@@terminal-1' } }
      },
      runtimeStatusByEnvironmentId: new Map([
        ['env-1', { snapshot: { transport: mocks.owner.transport } }]
      ])
    })
  }
}))
vi.mock('../lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.owner.environmentId
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('host-tab split source', () => {
  beforeEach(() => {
    mocks.owner.environmentId = 'env-1'
    mocks.owner.transport = 'ready'
    mocks.toastError.mockReset()
  })

  it('reads the terminal the workspace’s server published for the pane', () => {
    expect(readHostPublishedSplitSourcePtyId(SOURCE)).toBe('remote:env-1@@terminal-1')
  })

  // A split sent from it would run on a server the workspace no longer belongs to.
  it('ignores a binding naming another server', () => {
    mocks.owner.environmentId = 'env-2'
    expect(readHostPublishedSplitSourcePtyId(SOURCE)).toBeNull()
  })

  it.each([
    ['still starting', 'ready', 'its terminal hasn’t started'],
    ['disconnected', 'disconnected', 'not connected to a remote Orca host']
  ])('tells the user why the split was refused while the server is %s', (_c, transport, text) => {
    mocks.owner.transport = transport
    notifyHostTabSplitRefused(SOURCE)
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining(text), expect.anything())
  })
})
