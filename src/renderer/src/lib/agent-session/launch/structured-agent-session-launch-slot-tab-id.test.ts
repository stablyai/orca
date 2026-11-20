import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'

const mocks = vi.hoisted((): { store: unknown } => ({ store: null }))

vi.mock('@/store/index', () => ({
  get useAppStore() {
    return mocks.store
  }
}))

createStoreCascadesMockApi()

import { openStructuredAgentSessionProvisionalTab } from './structured-agent-session-launch-surface'
import {
  createStructuredAgentSessionLaunchIntent,
  restoreStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent
} from './structured-agent-session-launch-intent'
import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-record'
import { writeStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'

const WT = 'folder:folder-1'
const ROOT = 'group-root'

let store: ReturnType<typeof createTestStore>

beforeEach(() => {
  store = createTestStore()
  mocks.store = store
  seedStore(store, {
    activeWorktreeId: WT,
    groupsByWorktree: { [WT]: [{ id: ROOT, worktreeId: WT, activeTabId: null, tabOrder: [] }] },
    activeGroupIdByWorktree: { [WT]: ROOT },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: ROOT } },
    unifiedTabsByWorktree: { [WT]: [] }
  })
})

function open(sessionId: string, executionHostId: 'local' | `runtime:${string}` = 'local') {
  return openStructuredAgentSessionProvisionalTab({
    worktreeId: WT,
    executionHostId,
    sessionId,
    agent: 'codex'
  })
}

describe('a chat launch tab id', () => {
  it('stays the legacy id for a new chat, which create sends no tab id for', () => {
    const intent = createStructuredAgentSessionLaunchIntent(WT, 'codex', 'local')
    expect(intent.params.tabId).toBeUndefined()
    writeStructuredAgentLaunchRecord(structuredAgentLaunchRecordFor(intent, 'pending'))
    expect(open(intent.sessionId).id).toBe(`structured-agent-session-${intent.sessionId}`)
    // One chat, one tab: opening it again shows the same tab.
    expect(open(intent.sessionId).id).toBe(`structured-agent-session-${intent.sessionId}`)
    expect(store.getState().unifiedTabsByWorktree[WT]).toHaveLength(1)
  })

  it('keeps an id its create recorded through a retry, a reload and the drawn tab', () => {
    const base = createStructuredAgentSessionLaunchIntent(WT, 'codex', 'local')
    const tabId = 'chat-tab-recorded'
    const intent = restoreStructuredAgentSessionLaunchIntent({
      ...structuredAgentLaunchRecordFor(base, 'pending'),
      worktreeId: WT,
      tabId
    })
    expect(retryStructuredAgentSessionLaunchIntent(intent).params.tabId).toBe(tabId)
    const record = structuredAgentLaunchRecordFor(intent, 'pending')
    expect(record.tabId).toBe(tabId)
    expect(
      restoreStructuredAgentSessionLaunchIntent({ ...record, worktreeId: WT }).params.tabId
    ).toBe(tabId)
    writeStructuredAgentLaunchRecord(record)
    expect(open(intent.sessionId).id).toBe(tabId)
  })
})
