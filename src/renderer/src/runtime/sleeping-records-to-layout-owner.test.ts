import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from '../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'
import { recordPaneWakeThroughLayoutOwner } from '../store/terminals/terminal-sleep-layout-owner'
import { followSleepingRecordsInLayoutOwner } from './sleeping-records-to-layout-owner'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(
    async (_target: unknown, _method: string, _params: { command: unknown }) => ({
      ok: true,
      result: {}
    })
  )
}))
const held: { store?: ReturnType<typeof createTestStore> } = {}
vi.mock('@/store', () => ({
  get useAppStore() {
    return held.store
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const LOCAL = 'repo1::/path/wt'
const PAIRED = 'repo2::/remote/wt'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PANE = `${TAB}:11111111-1111-4111-8111-111111111111`
const PAIRED_TAB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const PAIRED_PANE = `${PAIRED_TAB}:22222222-2222-4222-8222-222222222222`

function record(paneKey: string, worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
}

function terminalRow(id: string, worktreeId: string) {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function setRecords(records: Record<string, SleepingAgentSessionRecord>): void {
  held.store!.setState({ sleepingAgentSessionsByPaneKey: records })
}

const sent = () => mocks.callRuntimeRpc.mock.calls.map((call) => call[2].command)

beforeAll(() => {
  const store = createTestStore()
  seedStore(
    store,
    runtimeOwnedRepoState('env-1', 'repo2', '/remote', {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: LOCAL, repoId: 'repo1', path: '/path/wt' })],
        repo2: [makeRuntimeOwnedWorktree({ id: PAIRED, repoId: 'repo2' }, 'env-1')]
      },
      tabsByWorktree: {
        [LOCAL]: [terminalRow(TAB, LOCAL)],
        [PAIRED]: [terminalRow(PAIRED_TAB, PAIRED)]
      },
      // Restore's records are main's own.
      sleepingAgentSessionsByPaneKey: { [PANE]: { ...record(PANE, LOCAL), state: 'done' } }
    })
  )
  held.store = store
})

beforeEach(() => {
  mocks.callRuntimeRpc.mockClear()
})

describe('main’s copy of the window’s resume records', () => {
  it('sends nothing for the records restore loaded, and subscribes once', () => {
    followSleepingRecordsInLayoutOwner()
    followSleepingRecordsInLayoutOwner()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    setRecords({})
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('records an added record without stopping its pane, and a dropped one without starting it', () => {
    const live = record(PANE, LOCAL)
    setRecords({ [PANE]: live })
    setRecords({})

    expect(sent()).toEqual([
      {
        type: 'sleep',
        workspace: LOCAL,
        tabId: TAB,
        paneKeys: [PANE],
        records: [live],
        recordOnly: true
      },
      { type: 'wake', workspace: LOCAL, tabId: TAB, paneKeys: [PANE], recordOnly: true }
    ])
  })

  it('sends nothing for a paired server’s workspace', () => {
    setRecords({ [PAIRED_PANE]: record(PAIRED_PANE, PAIRED) })
    setRecords({})

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends a resumed pane’s wake, record-only so main starts nothing, before the record drop', () => {
    setRecords({ [PANE]: record(PANE, LOCAL) })
    mocks.callRuntimeRpc.mockClear()

    recordPaneWakeThroughLayoutOwner(held.store!.getState(), LOCAL, PANE)
    held.store!.getState().clearSleepingAgentSession(PANE)

    expect(sent()).toEqual([
      { type: 'wake', workspace: LOCAL, tabId: TAB, paneKeys: [PANE], recordOnly: true },
      { type: 'wake', workspace: LOCAL, tabId: TAB, paneKeys: [PANE], recordOnly: true }
    ])
  })
})
