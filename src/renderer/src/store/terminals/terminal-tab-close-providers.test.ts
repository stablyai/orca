import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPtyOwner } from '@/lib/terminal-worktree-route'
import { createTestStore } from '../slices/store-test-helpers'
import { startTerminalTabProviderRetirement } from './terminal-tab-close-providers'

const mocks = vi.hoisted(() => {
  const ptyOwner: { current: TerminalPtyOwner } = { current: { kind: 'non-runtime' } }
  return { ptyOwner, callRuntimeRpc: vi.fn(async () => undefined) }
})

vi.mock('@/lib/terminal-worktree-route', () => ({
  resolveTerminalPtyOwner: () => mocks.ptyOwner.current,
  resolveTerminalWorktreeRoute: () => ({ runtimeEnvironmentId: 'env-a' })
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  ensureRuntimeEnvironmentCompatible: vi.fn()
}))

function retire(): void {
  startTerminalTabProviderRetirement({
    localPtyTeardownOwnedExternally: false,
    remoteCloseOwnedByHost: false,
    state: createTestStore().getState(),
    tabId: 'tab-1',
    retirementPlan: {
      tabId: 'tab-1',
      worktreeId: 'repo::wt',
      ptyIds: ['remote:handle-1'],
      localOrSshPtyIds: [],
      runtimeTerminals: [{ ptyId: 'remote:handle-1', environmentId: null, handle: 'handle-1' }],
      cleanupOnlyPtyIds: [],
      sharedPtyIds: [],
      unroutablePtyIds: []
    }
  })
}

describe('closing an unscoped remote terminal id', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    mocks.callRuntimeRpc.mockClear()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it('closes it where spawn started it', () => {
    mocks.ptyOwner.current = { kind: 'runtime', environmentId: 'env-a' }
    retire()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-a' },
      'terminal.close',
      { terminal: 'handle-1' }
    )
  })

  it('skips and logs it, never closing on this app, when the owner is ambiguous', () => {
    mocks.ptyOwner.current = { kind: 'ambiguous' }
    retire()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[terminal-retirement] skipped PTYs with no resolvable owner',
      {
        tabId: 'tab-1',
        worktreeKind: expect.any(String),
        count: 1
      }
    )
  })
})
