// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  createIntent: vi.fn(),
  launch: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  refreshTabs: vi.fn(),
  activateTab: vi.fn(),
  focusGroup: vi.fn(),
  statusBySession: new Map<string, AgentSessionStatusSummary['status']>(),
  liveSessions: new Set<string>()
}))

type StoreState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  nativeChatLaunchDraftByTabId: Record<string, { text: string; adopted?: boolean }>
}
/** A workspace split into a left (active) and a right tab group. */
function emptyStoreState(): StoreState {
  const group = (id: string): TabGroup => ({
    id,
    worktreeId: 'wt-reuse',
    activeTabId: null,
    tabOrder: []
  })
  return {
    unifiedTabsByWorktree: {},
    groupsByWorktree: { 'wt-reuse': [group('group-left'), group('group-right')] },
    activeGroupIdByWorktree: { 'wt-reuse': 'group-left' },
    nativeChatLaunchDraftByTabId: {}
  }
}
const store = vi.hoisted((): { state: StoreState } => ({ state: emptyStoreState() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), message: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))
vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  class StructuredAgentSessionOwnerUnresolvedError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError,
    StructuredAgentSessionOwnerUnresolvedError
  }
})
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mocks.refreshTabs
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    getSessionObservation: (sessionId: string) =>
      mocks.liveSessions.has(sessionId) ? 'live' : 'unverifiable',
    getSnapshot: () =>
      new Map(
        [...mocks.statusBySession].map(([sessionId, status]) => [sessionId, { sessionId, status }])
      )
  })
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...store.state,
      createUnifiedTab: (
        worktreeId: string,
        contentType: Tab['contentType'],
        init: { targetGroupId?: string }
      ) => {
        const groupId =
          init.targetGroupId ?? store.state.activeGroupIdByWorktree[worktreeId] ?? 'group-left'
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch passes the agent-session fields a structured tab carries.
        const tab = { ...init, contentType, worktreeId, groupId, createdAt: 1 } as Tab
        store.state.unifiedTabsByWorktree[worktreeId] = [
          ...(store.state.unifiedTabsByWorktree[worktreeId] ?? []),
          tab
        ]
        return tab
      },
      activateTab: mocks.activateTab,
      focusGroup: mocks.focusGroup,
      setActiveTabType: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => undefined
  }
}))

import {
  appendStructuredAgentSessionOutboxMessage,
  readOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests
} from '@/components/native-chat/use-native-chat-composer-attachments'
import {
  clearNativeChatDraftCacheForTests,
  writeNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import {
  beginStructuredAgentSessionProvisionalLaunch,
  type StructuredAgentSessionProvisionalLaunch
} from './structured-agent-session-provisional-tab'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'

const WORKTREE_ID = 'wt-reuse'

function launchIntent(
  sessionId: string,
  worktreeId = WORKTREE_ID
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
    executionHostId: 'local',
    target: { kind: 'local' },
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

function published(...sessionIds: string[]): RuntimeMobileSessionTabsResult[] {
  return [WORKTREE_ID, 'wt-other'].map((worktree) => ({
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: sessionIds.map((sessionId) => ({
      type: 'agent-session',
      id: `tab-${sessionId}`,
      title: 'Codex',
      sessionId,
      agent: 'codex',
      isActive: false
    }))
  }))
}

const first = launchIntent('session-first')
const second = launchIntent('session-second')

/** A pick from the + menu, new-tab search or the new-agent shortcut: its own action, no text. */
function pick(
  requestId: string,
  overrides: {
    agent?: 'claude' | 'codex'
    worktreeId?: string
    prompt?: string
    /** The split the pick was made in; none means the workspace's active group. */
    group?: string
  } = {}
): Exclude<StructuredAgentSessionProvisionalLaunch, { sessionId: null }> {
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan: adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId,
      agent: overrides.agent ?? 'codex',
      worktreeId: overrides.worktreeId ?? WORKTREE_ID,
      executionHostId: 'local',
      ...(overrides.prompt
        ? { prompt: overrides.prompt, promptDelivery: 'submit-after-ready' as const }
        : {})
    }),
    hooks: {},
    ...(overrides.group ? { targetGroupId: overrides.group } : {})
  })
  if (!launch || launch.sessionId === null) {
    throw new Error('expected a local chat')
  }
  return launch
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

/** The first chat published and its host's journal holds no request. */
async function publishIdle(sessionId: string): Promise<void> {
  await flush()
  expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, sessionId)).toBeNull()
  mocks.liveSessions.add(sessionId)
  mocks.statusBySession.set(sessionId, null)
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  clearNativeChatAttachmentCacheForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  mocks.statusBySession.clear()
  mocks.liveSessions.clear()
  store.state = emptyStoreState()
  mocks.createIntent
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second)
    .mockReturnValueOnce(launchIntent('session-third'))
  mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
    Promise.resolve({ sessionId: intent.sessionId, fence: 1 })
  )
  mocks.refreshTabs.mockResolvedValue(published(first.sessionId, second.sessionId))
  mocks.callStructuredAgentSession.mockResolvedValue({
    ok: true,
    value: { submission: { dispatchState: 'accepted' } }
  })
})

describe('a second "new chat" with no text', () => {
  it('focuses the empty chat still starting instead of opening another', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const firstPick = pick('plus-pick-1')
    const secondPick = pick('plus-pick-2')

    expect(secondPick.sessionId).toBe(firstPick.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(store.state.unifiedTabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(mocks.activateTab).toHaveBeenCalledWith(structuredAgentSessionTabId(first.sessionId), {
      worktreeId: WORKTREE_ID
    })
  })

  it('focuses the empty chat that published and sits idle, and reports that session', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)

    const secondPick = pick('plus-pick-2')

    expect(secondPick.sessionId).toBe(first.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.activateTab).toHaveBeenCalledWith(structuredAgentSessionTabId(first.sessionId), {
      worktreeId: WORKTREE_ID
    })
    await expect(secondPick.settlement).resolves.toEqual({
      kind: 'structured',
      sessionId: first.sessionId
    })
  })

  it('opens a new chat when the idle chat has a typed draft', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)
    const tabId = structuredAgentSessionTabId(first.sessionId)
    writeNativeChatDraftCache(structuredAgentSessionPaneKey(tabId, first.sessionId), 'half a q')

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it('opens a new chat when the idle chat has an image in its composer', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)
    const tabId = structuredAgentSessionTabId(first.sessionId)
    appendNativeChatAttachmentCache(structuredAgentSessionPaneKey(tabId, first.sessionId), [
      { id: 'shot', path: '/tmp/shot.png' }
    ])

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it('opens a new chat when the idle chat holds a launch draft its composer has not taken', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)
    store.state.nativeChatLaunchDraftByTabId[structuredAgentSessionTabId(first.sessionId)] = {
      text: 'PR context'
    }

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it('opens a new chat when its host holds a sent message', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)
    mocks.statusBySession.set(first.sessionId, 'idle')

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it('opens a new chat when its host cannot be heard from', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)
    mocks.liveSessions.clear()

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it('opens a new chat when the starting chat has a message queued', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const firstPick = pick('plus-pick-1')
    appendStructuredAgentSessionOutboxMessage(firstPick.sessionId, 'my own question')

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it('never reuses a chat whose start failed', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('@/lib/launch-structured-agent-session')
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
    pick('plus-pick-1')
    await flush()
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, first.sessionId)).toBe('failed')
    mocks.liveSessions.add(first.sessionId)
    mocks.statusBySession.set(first.sessionId, null)

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it('never reuses a chat whose start is unconfirmed', async () => {
    mocks.launch.mockRejectedValueOnce(new Error('answer lost'))
    mocks.refreshTabs.mockResolvedValue(published())
    pick('plus-pick-1')
    await flush()
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, first.sessionId)).toBe(
      'visibility-unknown'
    )
    mocks.liveSessions.add(first.sessionId)
    mocks.statusBySession.set(first.sessionId, null)

    expect(pick('plus-pick-2').sessionId).toBe(second.sessionId)
  })

  it("never reuses another agent's or another workspace's idle empty chat", async () => {
    mocks.createIntent
      .mockReset()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce({ ...second, agent: 'claude' })
      .mockReturnValueOnce(launchIntent('session-third', 'wt-other'))
    pick('plus-pick-1')
    await publishIdle(first.sessionId)

    expect(pick('claude-pick', { agent: 'claude' }).sessionId).toBe(second.sessionId)
    expect(pick('other-pick', { worktreeId: 'wt-other' }).sessionId).toBe('session-third')
  })

  it("never reuses another agent's or another workspace's starting empty chat", async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    mocks.createIntent
      .mockReset()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce({ ...second, agent: 'claude' })
      .mockReturnValueOnce(launchIntent('session-third', 'wt-other'))
    pick('plus-pick-1')

    expect(pick('claude-pick', { agent: 'claude' }).sessionId).toBe(second.sessionId)
    expect(pick('other-pick', { worktreeId: 'wt-other' }).sessionId).toBe('session-third')
  })
})

describe('a second "new chat" with no text in another split', () => {
  function tabOf(sessionId: string): Tab | undefined {
    return store.state.unifiedTabsByWorktree[WORKTREE_ID]?.find(
      (tab) => tab.id === structuredAgentSessionTabId(sessionId)
    )
  }

  it('opens a new chat in its own split beside an idle empty one, and focus stays there', async () => {
    pick('plus-pick-1', { group: 'group-left' })
    await publishIdle(first.sessionId)

    const right = pick('plus-pick-2', { group: 'group-right' })

    expect(right.sessionId).toBe(second.sessionId)
    expect(tabOf(second.sessionId)?.groupId).toBe('group-right')
    expect(mocks.focusGroup).not.toHaveBeenCalled()
    expect(mocks.activateTab).not.toHaveBeenCalled()
  })

  it('reuses the idle empty chat in the split it was picked in', async () => {
    pick('plus-pick-1', { group: 'group-right' })
    await publishIdle(first.sessionId)

    expect(pick('plus-pick-2', { group: 'group-right' }).sessionId).toBe(first.sessionId)
    expect(mocks.focusGroup).toHaveBeenCalledWith(WORKTREE_ID, 'group-right')
  })

  it('opens a new chat in its own split beside a starting empty one', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    pick('plus-pick-1', { group: 'group-left' })

    const right = pick('plus-pick-2', { group: 'group-right' })

    expect(right.sessionId).toBe(second.sessionId)
    expect(tabOf(second.sessionId)?.groupId).toBe('group-right')
    expect(mocks.focusGroup).not.toHaveBeenCalled()
  })

  it('reuses the starting empty chat in the split it was picked in', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const firstPick = pick('plus-pick-1', { group: 'group-right' })

    expect(pick('plus-pick-2', { group: 'group-right' }).sessionId).toBe(firstPick.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
  })

  // The dashboard and other callers name no group: the workspace's active one is where they open.
  it('treats a pick that names no split as made in the active one', async () => {
    pick('plus-pick-1', { group: 'group-right' })
    await publishIdle(first.sessionId)

    expect(pick('dashboard-pick').sessionId).toBe(second.sessionId)
    expect(tabOf(second.sessionId)?.groupId).toBe('group-left')
    store.state.activeGroupIdByWorktree[WORKTREE_ID] = 'group-right'
    expect(pick('dashboard-pick-2').sessionId).toBe(first.sessionId)
  })
})

describe('a "new chat" with text', () => {
  it('opens its own chat beside an idle empty one', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)

    const notes = pick('notes-send', { prompt: 'review notes' })

    expect(notes.sessionId).toBe(second.sessionId)
    await expect(notes.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
  })

  it('opens its own chat in its own split beside an empty chat starting in another', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const blank = pick('plus-pick-1', { group: 'group-left' })

    const notes = pick('notes-send', { prompt: 'review notes', group: 'group-right' })

    expect(notes.sessionId).toBe(second.sessionId)
    expect(
      store.state.unifiedTabsByWorktree[WORKTREE_ID]?.find(
        (tab) => tab.entityId === second.sessionId
      )?.groupId
    ).toBe('group-right')
    expect(mocks.focusGroup).not.toHaveBeenCalled()
    expect(readOutbox(blank.sessionId)).toEqual([])
    expect(readOutbox(second.sessionId).map((entry) => entry.body.blocks)).toEqual([
      [{ type: 'text', text: 'review notes' }]
    ])
  })

  it('takes an empty chat starting in its own split', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const blank = pick('plus-pick-1', { group: 'group-right' })

    expect(pick('notes-send', { prompt: 'review notes', group: 'group-right' }).sessionId).toBe(
      blank.sessionId
    )
  })

  it('takes an empty chat still starting, as before', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const blank = pick('plus-pick-1')

    expect(pick('notes-send', { prompt: 'review notes' }).sessionId).toBe(blank.sessionId)
  })
})
