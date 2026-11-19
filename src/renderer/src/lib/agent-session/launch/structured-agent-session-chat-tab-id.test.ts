import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { structuredAgentSessionCreateParams } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import {
  compatibilityEntry,
  runtimeCompatibilityChecks
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

const mocks = vi.hoisted((): { store: unknown } => ({ store: null }))

vi.mock('@/store/index', () => ({
  get useAppStore() {
    return mocks.store
  }
}))

createStoreCascadesMockApi()

import { openStructuredAgentSessionProvisionalTab } from './structured-agent-session-launch-surface'
import { withMintedChatTabId } from './structured-agent-session-chat-tab-id'

const WT = 'folder:folder-1'
const ROOT = 'group-root'
const PAIRED = 'env-paired'

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

afterEach(() => {
  runtimeCompatibilityChecks.clear()
})

function pairedHost(capabilities: string[]): void {
  runtimeCompatibilityChecks.set(
    PAIRED,
    compatibilityEntry({ capabilities } as unknown as RuntimeStatus)
  )
}

function open(sessionId: string, executionHostId: 'local' | `runtime:${string}` = 'local') {
  return openStructuredAgentSessionProvisionalTab({
    worktreeId: WT,
    executionHostId,
    sessionId,
    agent: 'codex'
  })
}

function createParams(sessionId: string, environmentId?: string) {
  return withMintedChatTabId({
    target: environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
    worktreeId: WT,
    sessionId,
    params: structuredAgentSessionCreateParams({
      sessionId,
      worktree: WT,
      agent: 'codex',
      randomUuid: () => '00000000-0000-4000-8000-000000000001'
    })
  })
}

describe('a new chat tab id', () => {
  it('is minted, not derived from the chat, and create hands it to this computer', () => {
    const tab = open('chat-1')
    expect(tab.id).toMatch(/^chat-tab-./)
    expect(tab.id).not.toContain('chat-1')
    expect(store.getState().unifiedTabsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: tab.id, entityId: 'chat-1', contentType: 'agent-session' })
    ])
    expect(createParams('chat-1').tabId).toBe(tab.id)
  })

  it('opening the same chat again shows its one tab', () => {
    const first = open('chat-1')
    const again = open('chat-1')
    expect(again.id).toBe(first.id)
    expect(store.getState().unifiedTabsByWorktree[WT]).toHaveLength(1)
  })

  it('keeps the legacy id for a paired host too old to be told one', () => {
    pairedHost([])
    const tab = open('chat-2', `runtime:${PAIRED}`)
    expect(tab.id).toBe('structured-agent-session-chat-2')
    expect(createParams('chat-2', PAIRED).tabId).toBeUndefined()
  })

  it('is minted and sent to a paired host that takes it', () => {
    pairedHost(['agentSession.create.tab-id.v1'])
    const tab = open('chat-3', `runtime:${PAIRED}`)
    expect(tab.id).toMatch(/^chat-tab-./)
    expect(createParams('chat-3', PAIRED).tabId).toBe(tab.id)
  })

  it('keeps a slot reserved under the legacy id before a restart', () => {
    store.getState().reorderUnifiedTabs(ROOT, ['structured-agent-session-chat-4'], {
      recordInteraction: false
    })
    expect(open('chat-4').id).toBe('structured-agent-session-chat-4')
    expect(createParams('chat-4').tabId).toBeUndefined()
  })
})
