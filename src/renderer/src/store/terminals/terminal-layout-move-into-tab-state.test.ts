import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'
import { resetAgentPaneAuthorityAliasesForTests } from '../slices/agent-pane-authority'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

const mockApi = createStoreCascadesMockApi()
Object.assign(mockApi, { session: { closeTerminalSurface: vi.fn().mockResolvedValue(undefined) } })

const WT = 'repo1::/repo/worktree'
const SOURCE = 'tab-source'
const TARGET = 'tab-target'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const FROM = `${SOURCE}:${A}`
const TO = `${TARGET}:${A}`
const MOVED = 'pty-moved'
const TARGET_PTY = 'pty-target'

function seedJoin(patch: Partial<Parameters<typeof seedStore>[1]> = {}) {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/repo/worktree' })] },
    tabsByWorktree: {
      [WT]: [
        makeTab({ id: SOURCE, worktreeId: WT, ptyId: MOVED }),
        makeTab({ id: TARGET, worktreeId: WT, ptyId: TARGET_PTY })
      ]
    },
    ptyIdsByTabId: { [SOURCE]: [MOVED], [TARGET]: [TARGET_PTY] },
    lastKnownRelayPtyIdByTabId: { [SOURCE]: MOVED, [TARGET]: TARGET_PTY },
    terminalLayoutsByTabId: {
      [SOURCE]: {
        root: { type: 'leaf', leafId: A },
        activeLeafId: A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [A]: MOVED }
      },
      // The renderer already grafted the leaf before the sync runs.
      [TARGET]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: B },
          second: { type: 'leaf', leafId: A }
        },
        activeLeafId: A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [B]: TARGET_PTY, [A]: MOVED }
      }
    },
    ...patch
  })
  return store
}

function sync(store: ReturnType<typeof seedJoin>): void {
  store.getState().syncPaneMoveIntoTabPtyOwnership({
    movedLeafId: A,
    movedPtyId: MOVED,
    sourceTabId: SOURCE,
    targetTabId: TARGET
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentPaneAuthorityAliasesForTests()
})

describe('syncPaneMoveIntoTabPtyOwnership', () => {
  it('R23: the source relay hint is dropped and the target one is left to updateTabPtyId', () => {
    const store = seedJoin()
    sync(store)

    expect(store.getState().lastKnownRelayPtyIdByTabId[TARGET]).toBe(TARGET_PTY)
    expect(store.getState().lastKnownRelayPtyIdByTabId[SOURCE]).toBeUndefined()
  })

  it('writes no tab PTY ownership: ptyIdsByTabId and tab rows are the apply step and closeTab', () => {
    const store = seedJoin()
    const before = store.getState()
    sync(store)

    expect(store.getState().ptyIdsByTabId).toBe(before.ptyIdsByTabId)
    expect(store.getState().tabsByWorktree).toBe(before.tabsByWorktree)
  })

  it('R24: clears the moved PTY from the source deferred and pending-reconnect slots only', () => {
    const store = seedJoin({
      deferredSshSessionIdsByTabId: { [SOURCE]: MOVED, [TARGET]: 'pty-deferred' },
      pendingReconnectPtyIdByTabId: { [SOURCE]: MOVED, [TARGET]: 'pty-pending' }
    })
    sync(store)

    expect(store.getState().deferredSshSessionIdsByTabId).toEqual({ [TARGET]: 'pty-deferred' })
    expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({ [TARGET]: 'pty-pending' })
  })

  it('R24: leaves another PTY in a source slot alone', () => {
    const store = seedJoin({ deferredSshSessionIdsByTabId: { [SOURCE]: 'pty-other' } })
    sync(store)

    expect(store.getState().deferredSshSessionIdsByTabId[SOURCE]).toBe('pty-other')
  })

  it('R27: moves the leaf local-only scrollback to the target tab', () => {
    const store = seedJoin({
      localOnlyScrollbackByTabId: { [SOURCE]: { [A]: 'scroll-a' }, [TARGET]: { [B]: 'scroll-b' } }
    })
    sync(store)

    expect(store.getState().localOnlyScrollbackByTabId).toEqual({
      [TARGET]: { [B]: 'scroll-b', [A]: 'scroll-a' }
    })
  })

  it('R39: copies the source unread tab marker only when the target has none', () => {
    const copied = seedJoin({ unreadTerminalTabs: { [SOURCE]: true } })
    sync(copied)
    expect(copied.getState().unreadTerminalTabs[TARGET]).toBe(true)

    const kept = seedJoin({ unreadTerminalTabs: { [SOURCE]: true, [TARGET]: 'agent-completion' } })
    sync(kept)
    expect(kept.getState().unreadTerminalTabs[TARGET]).toBe('agent-completion')
  })

  it('R26/R40: pane-keyed agent state, sleeping record and migration entry follow the pane', () => {
    const store = seedJoin()
    store.getState().setAgentStatus(FROM, { state: 'working', prompt: 'go', agentType: 'claude' })
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [FROM]: {
          paneKey: FROM,
          tabId: SOURCE,
          worktreeId: WT,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      },
      migrationUnsupportedByPtyId: {
        [MOVED]: {
          ptyId: MOVED,
          worktreeId: WT,
          tabId: SOURCE,
          leafId: A,
          paneKey: FROM,
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 5
        }
      }
    })
    sync(store)
    expect(store.getState().sleepingAgentSessionsByPaneKey[TO]).toMatchObject({ tabId: TARGET })
    store.getState().closeTab(SOURCE, { reason: 'cleanup', localPtyTeardownOwnedExternally: true })

    const state = store.getState()
    expect(state.agentStatusByPaneKey[FROM]).toBeUndefined()
    expect(state.agentStatusByPaneKey[TO]).toMatchObject({ paneKey: TO, tabId: TARGET })
    expect(state.sleepingAgentSessionsByPaneKey[FROM]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[TO]).toMatchObject({ paneKey: TO, tabId: TARGET })
    expect(state.migrationUnsupportedByPtyId[MOVED]).toMatchObject({ paneKey: TO, tabId: TARGET })
  })

  it('A1: closing the source after the sync kills no PTY while the target layout lists it', async () => {
    const store = seedJoin()
    sync(store)
    store.getState().closeTab(SOURCE, { reason: 'cleanup' })
    await Promise.resolve()

    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(store.getState().terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId?.[A]).toBe(MOVED)
  })

  it('A1: negative control, a source close with no target owner kills the PTY', async () => {
    const store = seedJoin({ terminalLayoutsByTabId: {}, ptyIdsByTabId: { [SOURCE]: [MOVED] } })
    store.getState().closeTab(SOURCE, { reason: 'cleanup' })
    await Promise.resolve()

    expect(mockApi.pty.kill).toHaveBeenCalledWith(MOVED)
  })
})
