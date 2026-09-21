import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import { __resetTrustPromptChainForTests, ensureHooksConfirmed } from './ensure-hooks-confirmed'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const hooksCheckMock = vi.fn()
const readIssueCommandMock = vi.fn()
const runtimeEnvironmentTransportCallMock = vi.fn()

// Why: a hand-rolled openModal double would decide the eviction outcome under test.
function createStateBackedByRealModalSlot(): {
  store: StoreApi<AppState>
  state: AppState
} {
  const store = createUIStore()
  store.setState({
    repos: [{ id: 'repo-1', displayName: 'Repo One' }],
    trustedOrcaHooks: {}
  } as unknown as Partial<AppState>)
  return { store, state: store.getState() }
}

async function settleOrReport<T>(promise: Promise<T>): Promise<T | 'never-settled'> {
  return Promise.race([
    promise,
    new Promise<'never-settled'>((resolve) => setTimeout(() => resolve('never-settled'), 100))
  ])
}

describe('orca.yaml trust prompt evicted from the modal slot', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset()
    readIssueCommandMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockReset()
    runtimeEnvironmentTransportCallMock.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      createCompatibleRuntimeStatusResponseIfNeeded(args)
    )
    clearRuntimeCompatibilityCacheForTests()
    vi.stubGlobal('window', {
      api: {
        hooks: { check: hooksCheckMock, readIssueCommand: readIssueCommandMock },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCallMock }
      }
    })
    __resetTrustPromptChainForTests()
    hooksCheckMock.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'pnpm install' } },
      mayNeedUpdate: false
    })
  })

  it('resolves the pending decision as skip when another modal takes the slot', async () => {
    const { store, state } = createStateBackedByRealModalSlot()
    const runSetup = vi.fn()

    const decision = ensureHooksConfirmed(state, 'repo-1', 'setup')
    await vi.waitFor(() => expect(store.getState().activeModal).toBe('confirm-orca-yaml-hooks'))

    store.getState().openModal('worktree-palette')

    const result = await settleOrReport(decision)
    if (result === 'run') {
      runSetup()
    }

    expect(result).toBe('skip')
    expect(runSetup).not.toHaveBeenCalled()
    expect(store.getState().trustedOrcaHooks).toEqual({})
  })

  it('resolves the pending decision as skip when the slot is closed outright', async () => {
    const { store, state } = createStateBackedByRealModalSlot()

    const decision = ensureHooksConfirmed(state, 'repo-1', 'setup')
    await vi.waitFor(() => expect(store.getState().activeModal).toBe('confirm-orca-yaml-hooks'))

    store.getState().closeModal()

    await expect(settleOrReport(decision)).resolves.toBe('skip')
  })

  it('keeps later trust prompts working after one is evicted', async () => {
    const { store, state } = createStateBackedByRealModalSlot()

    const evicted = ensureHooksConfirmed(state, 'repo-1', 'setup')
    await vi.waitFor(() => expect(store.getState().activeModal).toBe('confirm-orca-yaml-hooks'))
    store.getState().openModal('worktree-palette')
    await settleOrReport(evicted)

    const next = ensureHooksConfirmed(state, 'repo-1', 'setup')
    await vi.waitFor(() => expect(store.getState().activeModal).toBe('confirm-orca-yaml-hooks'))
    const onResolve = store.getState().modalData.onResolve as (d: 'run' | 'skip') => void
    onResolve('run')

    await expect(settleOrReport(next)).resolves.toBe('run')
  })

  it('leaves the answered decision alone when the dialog closes the slot itself', async () => {
    const { store, state } = createStateBackedByRealModalSlot()

    const decision = ensureHooksConfirmed(state, 'repo-1', 'setup')
    await vi.waitFor(() => expect(store.getState().activeModal).toBe('confirm-orca-yaml-hooks'))

    // Mirrors the trust dialog: resolve first, then vacate the slot.
    ;(store.getState().modalData.onResolve as (d: 'run' | 'skip') => void)('run')
    store.getState().closeModal()

    await expect(settleOrReport(decision)).resolves.toBe('run')
  })
})
