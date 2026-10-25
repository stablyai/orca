// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import type * as LaunchAdmissionModule from './structured-agent-session-launch-admission'
import type * as RpcClientModule from '@/runtime/runtime-rpc-client'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({
  createIntent: vi.fn(),
  launch: vi.fn(),
  callRuntimeRpc: vi.fn(),
  refreshTabs: vi.fn(),
  activateTab: vi.fn(),
  focusGroup: vi.fn(),
  statusBySession: new Map<string, AgentSessionStatusSummary['status']>(),
  liveSessions: new Set<string>()
}))

type StoreState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  activeGroupIdByWorktree: Record<string, string>
  nativeChatLaunchDraftByTabId: Record<string, { text: string; adopted?: boolean }>
}
/** A workspace split into a left (active) and a right tab group. */
function emptyStoreState(): StoreState {
  const group = (id: string): TabGroup => ({
    id,
    worktreeId: 'wt-new-chat',
    activeTabId: null,
    tabOrder: []
  })
  return {
    unifiedTabsByWorktree: {},
    groupsByWorktree: { 'wt-new-chat': [group('group-left'), group('group-right')] },
    layoutByWorktree: {
      'wt-new-chat': {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-left' },
        second: { type: 'leaf', groupId: 'group-right' }
      }
    },
    activeGroupIdByWorktree: { 'wt-new-chat': 'group-left' },
    nativeChatLaunchDraftByTabId: {}
  }
}
const store = vi.hoisted((): { state: StoreState } => ({ state: emptyStoreState() }))
type DrawnStore = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
}
/** Switch on: a real store drawn from main's frames stands in for `store`. */
const drawn = vi.hoisted((): { store: DrawnStore | null } => ({ store: null }))

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
// Each pick opens its chat once its host admits it; here this machine admits at once.
vi.mock('@/lib/structured-agent-session-launch-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchAdmissionModule>()),
  beginHostAdmittedStructuredLaunch: (args: { openAdmitted: () => unknown }) => args.openAdmitted()
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: mocks.refreshTabs
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.callRuntimeRpc(target, method, params)
}))
// Switch-on, main answers the window's chat opens and its frames draw them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply({
    ...(await importOriginal<typeof RpcClientModule>()),
    callRuntimeRpc: mocks.callRuntimeRpc,
    ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
  })
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
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
    getState: () =>
      drawn.store
        ? {
            ...drawn.store.getState(),
            activateTab: mocks.activateTab,
            focusGroup: mocks.focusGroup
          }
        : standInState(),
    subscribe: (listener: (state: AppState, previous: AppState) => void) =>
      drawn.store?.subscribe(listener) ?? (() => undefined)
  }
}))

function standInState() {
  return {
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
  }
}

import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { clearNativeChatDraftCacheForTests } from '@/components/native-chat/native-chat-draft-cache'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import {
  beginStructuredAgentSessionProvisionalLaunch,
  type StructuredAgentSessionProvisionalLaunch
} from './agent-session/structured-agent-session-provisional-tab'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt
} from './structured-agent-session-launch-prompt'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

const WORKTREE_ID = 'wt-new-chat'

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

let main: TabsDrawnFromMain | null = null

// Frame-drawn split workspace: each side needs a terminal because main drops empty groups.
async function drawSplitFromMain(): Promise<void> {
  const real = createTestStore()
  const side = (groupId: string): Tab => ({
    id: `terminal-${groupId}`,
    entityId: `terminal-${groupId}`,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  const seeded = emptyStoreState()
  seedStore(real, {
    worktreesByRepo: { repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo' })] },
    activeWorktreeId: WORKTREE_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: ['group-left', 'group-right'].map((groupId, index) => ({
        id: `terminal-${groupId}`,
        ptyId: null,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 1
      }))
    },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [side('group-left'), side('group-right')] },
    groupsByWorktree: {
      [WORKTREE_ID]: seeded.groupsByWorktree[WORKTREE_ID]!.map((group) => ({
        ...group,
        activeTabId: `terminal-${group.id}`,
        tabOrder: [`terminal-${group.id}`]
      }))
    },
    layoutByWorktree: seeded.layoutByWorktree,
    activeGroupIdByWorktree: seeded.activeGroupIdByWorktree
  })
  main = await drawTabsFromMain(real)
  drawn.store = real
}

/** The chat tabs the workspace shows: switch-on, as main's frames drew them. */
async function openedChats(): Promise<Tab[]> {
  await main?.settle()
  const tabs = (drawn.store?.getState() ?? store.state).unifiedTabsByWorktree[WORKTREE_ID] ?? []
  return tabs.filter((tab) => tab.contentType === 'agent-session')
}

const first = launchIntent('session-first')
const second = launchIntent('session-second')

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
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentSessionSendsForTests()
  for (const sessionId of ['session-first', 'session-second', 'session-third']) {
    discardStructuredLaunchPrompts(sessionId)
  }
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
  mocks.callRuntimeRpc.mockResolvedValue({
    ok: true,
    value: { submission: { dispatchState: 'accepted' } }
  })
})

beforeEach(async () => {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await drawSplitFromMain()
  }
})

afterEach(() => {
  main?.close()
  main = null
  drawn.store = null
})

describe('a second "new chat" with no text', () => {
  it('opens a second chat while the first empty one is still starting', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const firstPick = pick('plus-pick-1')
    const secondPick = pick('plus-pick-2')

    expect(firstPick.sessionId).toBe(first.sessionId)
    expect(secondPick.sessionId).toBe(second.sessionId)
    expect(await openedChats()).toHaveLength(2)
  })

  it('opens a second chat beside an empty one that published and sits idle', async () => {
    pick('plus-pick-1')
    await publishIdle(first.sessionId)

    const secondPick = pick('plus-pick-2')

    expect(secondPick.sessionId).toBe(second.sessionId)
    expect(await openedChats()).toHaveLength(2)
    await expect(secondPick.settlement).resolves.toEqual({
      kind: 'structured',
      sessionId: second.sessionId
    })
  })

  it('opens one chat when the same pick is delivered twice', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const firstPick = pick('plus-pick-1')

    expect(pick('plus-pick-1').sessionId).toBe(firstPick.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
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

  it('opens its own chat beside an empty one still starting', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    const blank = pick('plus-pick-1')

    const notes = pick('notes-send', { prompt: 'review notes' })

    expect(notes.sessionId).toBe(second.sessionId)
    expect(await openedChats()).toHaveLength(2)
    expect(hasStagedStructuredLaunchPrompt(blank.sessionId)).toBe(false)
    expect(hasStagedStructuredLaunchPrompt(second.sessionId)).toBe(true)
  })

  it('opens its own chat in the split it was sent from', async () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))
    pick('plus-pick-1', { group: 'group-left' })

    const notes = pick('notes-send', { prompt: 'review notes', group: 'group-right' })

    expect(notes.sessionId).toBe(second.sessionId)
    expect((await openedChats()).find((tab) => tab.entityId === second.sessionId)?.groupId).toBe(
      'group-right'
    )
    expect(mocks.focusGroup).not.toHaveBeenCalled()
  })
})
