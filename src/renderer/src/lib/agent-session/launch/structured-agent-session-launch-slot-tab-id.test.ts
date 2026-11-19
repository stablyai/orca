import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
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

describe('a new chat tab id', () => {
  it('is minted into the create the host fingerprints, and the chat tab takes it', () => {
    const intent = createStructuredAgentSessionLaunchIntent(WT, 'codex', 'local')
    const { tabId } = intent.params
    expect(tabId).toMatch(/^chat-tab-./)
    expect(tabId).not.toContain(intent.sessionId)
    expect(intent.params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({ sessionId: intent.sessionId, ...intent.params })
    )
    writeStructuredAgentLaunchRecord(structuredAgentLaunchRecordFor(intent, 'pending'))
    expect(open(intent.sessionId).id).toBe(tabId)
    // One chat, one tab: opening it again shows the same tab.
    expect(open(intent.sessionId).id).toBe(tabId)
    expect(store.getState().unifiedTabsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: tabId, entityId: intent.sessionId })
    ])
  })

  it('survives a retry and a reload with the same id', () => {
    const intent = createStructuredAgentSessionLaunchIntent(WT, 'codex', 'local')
    expect(retryStructuredAgentSessionLaunchIntent(intent).params.tabId).toBe(intent.params.tabId)
    const record = structuredAgentLaunchRecordFor(intent, 'pending')
    const restored = restoreStructuredAgentSessionLaunchIntent({ ...record, worktreeId: WT })
    expect(restored.params.tabId).toBe(intent.params.tabId)
  })

  it('is not minted for a chat on a paired host, which keeps deriving the legacy id', () => {
    const intent = createStructuredAgentSessionLaunchIntent(WT, 'codex', 'runtime:env-paired')
    expect(intent.params.tabId).toBeUndefined()
    expect(open(intent.sessionId, 'runtime:env-paired').id).toBe(
      `structured-agent-session-${intent.sessionId}`
    )
  })

  it('keeps the legacy id for a launch recorded before ids were minted', () => {
    expect(open('chat-from-an-older-build').id).toBe(
      'structured-agent-session-chat-from-an-older-build'
    )
  })
})
