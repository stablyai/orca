import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  DirectSshAuthority,
  SshConnectionState,
  SshProviderEpoch
} from '../../../../shared/ssh-types'
import { makeTab, makeWorktree } from '@/store/slices/store-test-helpers'
import { registerDirectSshStateIpcBridge } from './direct-ssh-state-ipc-bridge'

function connectedState(
  targetId = 'target-a',
  generation = 1
): SshConnectionState & DirectSshAuthority {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests issue a fixed opaque provider token for each target.
    providerEpoch: `epoch-${targetId}` as SshProviderEpoch,
    connectionGeneration: generation
  }
}

function authority(state: DirectSshAuthority): DirectSshAuthority {
  return {
    targetId: state.targetId,
    providerEpoch: state.providerEpoch,
    connectionGeneration: state.connectionGeneration
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await Promise.resolve()
  }
}

const originalStore = useAppStore.getState()
const cleanups: (() => void)[] = []

const WORKTREE_ID = 'repo-ssh::/work/demo'
const TAB_ID = 'tab-ssh'
const PTY_ID = 'ssh:target-a@@pty-1'

function seedSshTab(): void {
  useAppStore.setState({
    repos: [
      {
        id: 'repo-ssh',
        path: '/work/demo',
        displayName: 'demo',
        badgeColor: '#000',
        addedAt: 1,
        connectionId: 'target-a',
        executionHostId: 'ssh:target-a'
      }
    ],
    worktreesByRepo: {
      'repo-ssh': [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo-ssh',
          path: '/work/demo',
          hostId: 'ssh:target-a'
        })
      ]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID, ptyId: PTY_ID })]
    },
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] }
  })
}

function expectSshTabBound(): void {
  const state = useAppStore.getState()
  expect(state.tabsByWorktree[WORKTREE_ID][0].ptyId).toBe(PTY_ID)
  expect(state.ptyIdsByTabId[TAB_ID]).toEqual([PTY_ID])
}

async function createHarness(
  initialStates: readonly SshConnectionState[] = [],
  reconciledStates: readonly SshConnectionState[] = []
) {
  const states = new Map(initialStates.map((state) => [state.targetId, state]))
  const reconciled = new Map(reconciledStates.map((state) => [state.targetId, state]))
  let stateListener: ((event: { targetId: string; state: unknown }) => void) | undefined
  const getState = vi.fn(async ({ targetId }: { targetId: string }) => {
    const state = states.get(targetId) ?? null
    const next = reconciled.get(targetId)
    if (next) {
      states.set(targetId, next)
    }
    return state
  })
  const targets = ['target-a', 'target-b'].map((id) => ({ id, label: id }))
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    api: {
      ui: {},
      repos: {},
      worktrees: {},
      ssh: {
        listTargets: async () => targets,
        listRemovedTargetLabels: async () => ({}),
        getState,
        listPortForwards: async () => [],
        listUnrestoredPortForwards: () => Promise.resolve([]),
        listDetectedPorts: async () => [],
        onCredentialRequest: () => () => {},
        onCredentialResolved: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onStateChanged: (listener: typeof stateListener) => {
          stateListener = listener
          return () => {}
        }
      }
    }
  })
  const unsubs: (() => void)[] = []
  const stop = registerDirectSshStateIpcBridge(unsubs)
  cleanups.push(() => {
    for (const unsubscribe of unsubs) {
      unsubscribe()
    }
    stop()
  })
  await settle()
  return {
    getState,
    emit: (state: SshConnectionState) => {
      if (!stateListener) {
        throw new Error('SSH state listener was not registered')
      }
      stateListener({ targetId: state.targetId, state })
    },
    applyConnectReply: (state: SshConnectionState) => {
      useAppStore.getState().setSshConnectionState(state.targetId, state)
    }
  }
}

beforeEach(() => {
  useAppStore.setState(originalStore, true)
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  await settle()
  vi.restoreAllMocks()
  useAppStore.setState(originalStore, true)
  vi.unstubAllGlobals()
})

describe('direct SSH connected-state routing', () => {
  it.each(['reply-first', 'push-first'] as const)(
    'keeps the target bindings on connected pushes when ordering is %s',
    async (ordering) => {
      seedSshTab()
      const harness = await createHarness()
      const state = connectedState()
      if (ordering === 'reply-first') {
        harness.applyConnectReply(state)
      }
      harness.emit(state)
      if (ordering === 'push-first') {
        harness.applyConnectReply(state)
      }
      await settle()
      harness.emit({ ...state })

      expectSshTabBound()
    }
  )

  it.each(['disconnected', 'error'] as const)(
    'keeps bindings on %s and on the next connected push',
    async (status) => {
      seedSshTab()
      const state = connectedState()
      const harness = await createHarness([state])
      harness.emit({ ...state, status })
      // Loss of contact is not evidence the remote PTY exited.
      expectSshTabBound()

      harness.applyConnectReply(state)
      harness.emit(state)
      expectSshTabBound()
    }
  )

  it.each(['providerEpoch', 'connectionGeneration'] as const)(
    'reconciles a partial %s on initial hydration',
    async (missingField) => {
      const state = connectedState()
      const partial: SshConnectionState = { ...state }
      delete partial[missingField]
      await createHarness([partial], [state])

      expect(useAppStore.getState().sshConnectionStates.get(state.targetId)).toEqual(state)
    }
  )

  it.each(['providerEpoch', 'connectionGeneration'] as const)(
    'waits for partial authority reconciliation when %s is missing',
    async (missingField) => {
      const harness = await createHarness()
      const state = connectedState()
      let resolveState!: (state: SshConnectionState) => void
      harness.getState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveState = resolve
          })
      )
      harness.applyConnectReply(state)
      const partial: SshConnectionState = { ...state }
      delete partial[missingField]
      harness.emit(partial)
      expect(useAppStore.getState().sshConnectionStates.get(state.targetId)).toEqual(partial)

      resolveState(state)
      await settle()

      expect(useAppStore.getState().sshConnectionStates.get(state.targetId)).toMatchObject(
        authority(state)
      )
    }
  )
})
