// @vitest-environment happy-dom

import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import { advanceRuntimeEnvironmentConnectionGeneration } from '../store/slices/runtime-status-connection-generation'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  stageHostCreatedLaunchPrompt,
  stagedStructuredLaunchPrompts,
  settleHostCreatedLaunchResult,
  dismissHostCreatedLaunchPrompt,
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt
} from '../lib/structured-agent-session-launch-prompt'
import {
  resetStructuredAgentSessionSendsForTests,
  reserveStructuredAgentSessionSend
} from '../components/native-chat/structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  subscribeToStructuredAgentSessionPendingSends
} from '../components/native-chat/structured-agent-session-pending-sends'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache,
  clearNativeChatDraftCacheForTests,
  subscribeToNativeChatDraftAppend
} from '../components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '../components/native-chat/native-chat-composer-draft-store'
import { instrumentUnrelatedTerminalBindings } from './workspace-initial-terminal-census.test-fixture'
import { useAppStore } from '../store'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import { applyStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { materializeWorkspaceInitialSurface } from './workspace-initial-surface-materialization'
import { resolveWebSessionVisibleTabId } from './web-session-focus-intent'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'
import { recordWebSessionCloseIntent } from './web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

const WORKTREE = 'repo::new-worktree'
const OTHER = 'repo::other-worktree'
const AGENT = 'agent-terminal'
const ANCILLARY = 'setup-terminal'
const LEAF = '00000000-0000-4000-8000-000000000001'
const SETUP_LEAF = '00000000-0000-4000-8000-000000000002'
const SESSION = 'initial-chat'

function topology(mode: 'chat' | 'terminal'): RuntimeMobileSessionTabsResult {
  const agentId = mode === 'chat' ? `agent-session:${SESSION}` : `${AGENT}::${LEAF}`
  return {
    worktree: WORKTREE,
    publicationEpoch: 'initial-host-epoch',
    snapshotVersion: 2,
    activeTabId: agentId,
    activeTabType: mode === 'chat' ? 'agent-session' : 'terminal',
    activeGroupId: 'host-group',
    tabGroups: [{ id: 'host-group', activeTabId: agentId, tabOrder: [agentId, ANCILLARY] }],
    tabs: [
      mode === 'chat'
        ? {
            type: 'agent-session',
            id: agentId,
            title: 'Claude Chat',
            sessionId: SESSION,
            agent: 'claude',
            isActive: true
          }
        : {
            type: 'terminal',
            id: agentId,
            parentTabId: AGENT,
            leafId: LEAF,
            title: 'Claude',
            terminal: 'agent-pty',
            status: 'ready',
            isActive: true
          },
      {
        type: 'terminal',
        id: `${ANCILLARY}::${SETUP_LEAF}`,
        parentTabId: ANCILLARY,
        leafId: SETUP_LEAF,
        title: '',
        terminal: 'setup-pty',
        status: 'ready',
        isActive: false
      }
    ]
  }
}

function deliver(snapshot: RuntimeMobileSessionTabsResult): void {
  materializeWorkspaceInitialSurface({
    worktreeId: WORKTREE,
    initialWorkspaceTopology: snapshot,
    ptyId: 'setup-pty',
    tabId: ANCILLARY,
    leafId: SETUP_LEAF,
    activate: false,
    surfaceOwner: false
  })
}

beforeEach(() => {
  createStoreSessionMockApi()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: OTHER,
    activeTabId: 'other-tab',
    bumpWorktreeActivity: vi.fn(),
    setTabCustomTitle: vi.fn()
  })
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

afterEach(() => {
  discardStructuredLaunchPrompts(SESSION)
  resetStructuredAgentSessionSendsForTests()
  clearNativeChatDraftCacheForTests()
  vi.useRealTimers()
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

describe('initial topology before ancillary terminal delivery', () => {
  it('adopts the native terminal from a result census without adding an empty ancillary tab', () => {
    const snapshot = topology('terminal')
    snapshot.tabs = snapshot.tabs.filter(
      (tab) => tab.type === 'terminal' && tab.parentTabId === AGENT
    )
    // The result refresh first consumes the chat projection at this same version.
    applyStructuredSessionTabSnapshots([snapshot])
    materializeWorkspaceInitialSurface(
      { worktreeId: WORKTREE, initialWorkspaceTopology: snapshot },
      { appendAncillary: false }
    )
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[WORKTREE]!.map((tab) => tab.id)).toEqual([AGENT])
    expect(state.terminalLayoutsByTabId[AGENT]!.ptyIdsByLeafId).toEqual({ [LEAF]: 'agent-pty' })
    expect(resolveWebSessionVisibleTabId(state, WORKTREE)).toBe(AGENT)
    expect(state.activeWorktreeId).toBe(OTHER)
  })

  it.each(['chat', 'terminal'] as const)(
    'selects the %s, never Setup, in an empty visible workspace',
    (mode) => {
      useAppStore.setState({
        activeWorktreeId: WORKTREE,
        activeTabId: null,
        activeTabIdByWorktree: { [OTHER]: 'other-tab' }
      })
      const committed: { visible: string | null; remembered: string | null | undefined }[] = []
      const stop = useAppStore.subscribe((state) => {
        committed.push({
          visible: resolveWebSessionVisibleTabId(state, WORKTREE),
          remembered: state.activeTabIdByWorktree[WORKTREE]
        })
      })
      deliver(topology(mode))
      stop()
      const state = useAppStore.getState()
      const tabs = state.unifiedTabsByWorktree[WORKTREE]!
      const agent = tabs.find((tab) => tab.entityId === (mode === 'chat' ? SESSION : AGENT))!
      const setup = tabs.find((tab) => tab.entityId === ANCILLARY)!
      expect(state.activeTabIdByWorktree[WORKTREE]).toBe(agent.id)
      expect(resolveWebSessionVisibleTabId(state, WORKTREE)).toBe(agent.id)
      expect(state.activeTabType).toBe(mode === 'chat' ? 'agent-session' : 'terminal')
      if (mode === 'terminal') {
        // The window's terminal repair restores the remembered tab only if it names a terminal.
        expect(state.tabsByWorktree[WORKTREE]!.map((tab) => tab.id)).toContain(
          state.activeTabIdByWorktree[WORKTREE]
        )
      }
      expect(state.activeWorktreeId).toBe(WORKTREE)
      expect(state.activeTabIdByWorktree[OTHER]).toBe('other-tab')
      expect(committed.length).toBeGreaterThan(0)
      for (const commit of committed) {
        expect([commit.visible, commit.remembered]).not.toContain(setup.id)
        expect([commit.visible, commit.remembered]).not.toContain(ANCILLARY)
      }
    }
  )

  it.each(['chat', 'terminal'] as const)(
    'initializes the %s before ancillary selection and keeps later choices through replay',
    (mode) => {
      const committed: (string | null)[] = []
      const stop = useAppStore.subscribe((state) => {
        committed.push(resolveWebSessionVisibleTabId(state, WORKTREE))
      })
      const snapshot = topology(mode)
      deliver(snapshot)
      stop()
      const initialized = useAppStore.getState()
      const agent = initialized.unifiedTabsByWorktree[WORKTREE]!.find((tab) =>
        mode === 'chat' ? tab.entityId === SESSION : tab.entityId === AGENT
      )!
      expect(committed.length).toBeGreaterThan(0)
      expect(committed.every((tabId) => tabId === agent.id)).toBe(true)
      expect(initialized.activeWorktreeId).toBe(OTHER)
      expect(initialized.activeTabId).toBe('other-tab')
      expect(initialized.activeTabIdByWorktree[WORKTREE]).toBe(agent.id)
      const published = buildMobileSessionTabSnapshots(initialized, false).find(
        (workspace) => workspace.worktree === WORKTREE
      )!
      if (mode === 'terminal') {
        expect(published.activeTabType).toBe('terminal')
        expect(published.activeTabId).toBe(snapshot.activeTabId)
      } else {
        // Chat rows are host-owned; the renderer publishes their group placement.
        expect(published.tabs.some((tab) => tab.isActive)).toBe(false)
        expect(
          published.tabGroups?.find((group) => group.id === published.activeGroupId)?.activeTabId
        ).toBe(snapshot.activeTabId)
      }
      expect(
        initialized.tabsByWorktree[WORKTREE]!.filter((tab) => tab.id === ANCILLARY)
      ).toHaveLength(1)
      if (mode === 'terminal') {
        expect(initialized.tabsByWorktree[WORKTREE]!.map((tab) => tab.id)).toEqual([
          AGENT,
          ANCILLARY
        ])
        expect(initialized.terminalLayoutsByTabId[AGENT]!.ptyIdsByLeafId).toEqual({
          [LEAF]: 'agent-pty'
        })
      }
      // The standalone inventory arrives after ancillary IPC, then a real Setup pick wins.
      applyStructuredSessionTabSnapshots([snapshot])
      const setup = useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKTREE]!.find((tab) => tab.entityId === ANCILLARY)!
      useAppStore.getState().activateTab(setup.id, { worktreeId: WORKTREE, recordFocus: false })
      useAppStore.getState().activateTab(setup.id, { worktreeId: WORKTREE, recordFocus: false })
      deliver({ ...snapshot, snapshotVersion: 3 })
      deliver(snapshot)
      const picked = useAppStore.getState()
      expect(resolveWebSessionVisibleTabId(picked, WORKTREE)).toBe(setup.id)
      useAppStore.setState({ activeWorktreeId: WORKTREE })
      expect(resolveWebSessionVisibleTabId(useAppStore.getState(), WORKTREE)).toBe(setup.id)
    }
  )

  it.each(['chat', 'terminal'] as const)(
    'keeps a closed %s fenced from delayed topology',
    (mode) => {
      recordWebSessionCloseIntent(
        { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
        WORKTREE,
        `agent-session:${SESSION}`,
        Date.now()
      )
      useAppStore.setState({
        closedTerminalTabTombstonesByTabId: {
          [AGENT]: { closedAt: Date.now(), worktreeId: WORKTREE, reason: 'user' }
        }
      })
      deliver(topology(mode))
      expect(useAppStore.getState().tabsByWorktree[WORKTREE]!.map((tab) => tab.id)).toEqual([
        ANCILLARY
      ])
      expect(useAppStore.getState().ptyIdsByTabId[AGENT]).toBeUndefined()
      expect(
        useAppStore
          .getState()
          .unifiedTabsByWorktree[WORKTREE]!.some((tab) => tab.entityId === SESSION)
      ).toBe(false)
    }
  )
})

function hostPrompt() {
  return stageHostCreatedLaunchPrompt({
    sessionId: SESSION,
    operationId: '1790000000123-0123456789abcdef0123456789abcdef',
    paneKey: `${AGENT}:${LEAF}`,
    text: 'opening A',
    executionHostId: 'local',
    target: { kind: 'local' },
    agent: 'claude',
    delivery: 'submit',
    terminalNotice: vi.fn(),
    presentDraft: vi.fn()
  })
}
function hostResult(messageId: string) {
  return {
    worktreeId: WORKTREE,
    outcome: { kind: 'structured' as const, sessionId: SESSION, handle: 'chat' },
    receipt: {
      mode: 'structured' as const,
      preferred: 'structured' as const,
      reason: 'requested' as const,
      detail: 'Chat requested'
    },
    prompt: { delivery: 'submit' as const, outcome: 'journaled' as const, messageId }
  }
}
it('holds opening input through long checkout and finishes exact proof after accepted topology without a watched echo', async () => {
  vi.useFakeTimers()
  const observerError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failedObserver = vi.fn().mockImplementationOnce(() => {
    throw new Error('view notification failed')
  })
  const stop = subscribeToStructuredAgentSessionPendingSends(SESSION, failedObserver)
  const prompt = hostPrompt()
  if (!prompt?.hostCreate) {
    throw new Error('missing host claim')
  }
  try {
    await vi.advanceTimersByTimeAsync(35_000)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(true)
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))).toBe('')
    deliver(topology('chat'))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(getStructuredAgentSessionPendingSends(SESSION)).toHaveLength(1)
    settleHostCreatedLaunchResult(SESSION, 'local', hostResult(prompt.hostCreate.messageId))
    expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    const ordinary = reserveStructuredAgentSessionSend({ sessionId: SESSION, text: 'ordinary B' })
    expect(ordinary).not.toBeNull()
    ordinary?.release()
    expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))).toBe('')
  } finally {
    stop()
    observerError.mockRestore()
  }
})
it('returns dismissed unknown input once at the accepted chat, preserving newer text before reentrant listeners and late proof', () => {
  const prompt = hostPrompt()
  if (!prompt?.hostCreate) {
    throw new Error('missing host claim')
  }
  const scope = structuredAgentSessionDraftScopeKey(SESSION)
  dismissHostCreatedLaunchPrompt(SESSION)
  writeNativeChatDraftCache(scope, 'newer user draft')
  const observe = vi.fn(() => {
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
    expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
    dismissHostCreatedLaunchPrompt(SESSION)
  })
  const stop = subscribeToNativeChatDraftAppend(scope, observe)
  try {
    deliver(topology('chat'))
    expect(observe).toHaveBeenCalledOnce()
    expect(readNativeChatDraftCache(scope)).toBe('newer user draft\n\nopening A')
    writeNativeChatDraftCache(scope, '')
    settleHostCreatedLaunchResult(SESSION, 'local', hostResult(prompt.hostCreate.messageId))
    applyStructuredSessionTabSnapshots([{ ...topology('chat'), snapshotVersion: 3 }])
    expect(readNativeChatDraftCache(scope)).toBe('')
    expect(observe).toHaveBeenCalledOnce()
  } finally {
    stop()
  }
})

it('keeps discovered terminal input quiet and abandons its exact claim on real tab close before a late refusal', () => {
  const prompt = hostPrompt()
  if (!prompt?.hostCreate) {
    throw new Error('missing host claim')
  }
  const snapshot = topology('terminal')
  for (const tab of snapshot.tabs) {
    if (tab.type === 'terminal' && tab.parentTabId === AGENT) {
      tab.launchAgent = 'claude'
    }
  }
  deliver(snapshot)
  expect(prompt.hostCreate.terminalNotice).not.toHaveBeenCalled()
  expect(prompt.hostCreate.presentDraft).not.toHaveBeenCalled()
  expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(true)
  useAppStore.setState({ terminalLayoutsByTabId: {} })
  useAppStore.getState().closeTab(AGENT, { reason: 'user' })
  expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
  settleHostCreatedLaunchResult(SESSION, 'local', {
    ...hostResult(prompt.hostCreate.messageId),
    outcome: { kind: 'terminal', handle: 'agent-pty', paneKey: `${AGENT}:${LEAF}` },
    prompt: { delivery: 'submit', outcome: 'not-delivered' }
  })
  expect(prompt.hostCreate.terminalNotice).not.toHaveBeenCalled()
  expect(prompt.hostCreate.presentDraft).not.toHaveBeenCalled()
  expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))).toBe('')
})

it('returns paired input only from a current accepted host publication after a connection changes', async () => {
  const environmentId = 'opening-input-host'
  replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 11 }])
  stageHostCreatedLaunchPrompt({
    sessionId: SESSION,
    operationId: '1790000000123-0123456789abcdef0123456789abcdef',
    paneKey: `${AGENT}:${LEAF}`,
    text: 'paired A',
    executionHostId: toRuntimeExecutionHostId(environmentId),
    target: { kind: 'environment', environmentId },
    agent: 'claude',
    delivery: 'submit',
    terminalNotice: vi.fn(),
    presentDraft: vi.fn()
  })
  dismissHostCreatedLaunchPrompt(SESSION)
  expect(decideWebSessionTabsSnapshot(topology('chat'), environmentId).apply).toBe(true)
  advanceRuntimeEnvironmentConnectionGeneration(environmentId)
  await Promise.resolve()
  expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))).toBe('')
  expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(true)
  expect(
    decideWebSessionTabsSnapshot({ ...topology('chat'), snapshotVersion: 3 }, environmentId).apply
  ).toBe(true)
  await Promise.resolve()
  expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))).toBe('paired A')
  expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
})

it('bounds accepted snapshot prompt work at N and 10N, with no traversal when this host has no claim', async () => {
  const reads = vi.spyOn(stagedStructuredLaunchPrompts, 'get')
  try {
    for (const route of ['initial', 'local', 'paired'] as const) {
      for (const size of [10, 100]) {
        resetLocalStructuredSessionVersionForTests()
        const snapshot: RuntimeMobileSessionTabsResult = {
          ...topology('chat'),
          snapshotVersion: size,
          tabs: Array.from({ length: size }, (_, i) => ({
            type: 'agent-session' as const,
            id: `agent-session:perf-${i}`,
            sessionId: `perf-${i}`,
            agent: 'claude',
            title: 'Chat',
            isActive: false
          }))
        }
        const apply = async () => {
          if (route === 'initial') {
            deliver(snapshot)
          } else if (route === 'local') {
            applyStructuredSessionTabSnapshots([snapshot], LOCAL_STRUCTURED_SESSION_OWNER, {
              reacceptCurrentVersion: true
            })
          } else {
            decideWebSessionTabsSnapshot(snapshot, `perf-${size}`)
            await Promise.resolve()
          }
        }
        reads.mockClear()
        await apply()
        expect(reads.mock.calls.filter(([key]) => key.startsWith('perf-'))).toHaveLength(0)
        const host = route === 'paired' ? toRuntimeExecutionHostId(`perf-${size}`) : 'local'
        const prompt = stageHostCreatedLaunchPrompt({
          sessionId: SESSION,
          operationId: '1790000000123-0123456789abcdef0123456789abcdef',
          paneKey: `${AGENT}:${LEAF}`,
          text: 'unsent draft',
          delivery: 'draft',
          executionHostId: host,
          target:
            route === 'paired'
              ? { kind: 'environment', environmentId: `perf-${size}` }
              : { kind: 'local' },
          agent: 'claude',
          presentDraft: vi.fn(),
          terminalNotice: vi.fn()
        })
        expect(prompt).not.toBeNull()
        snapshot.snapshotVersion++
        reads.mockClear()
        await apply()
        const count = reads.mock.calls.filter(([key]) => key.startsWith('perf-')).length
        expect(count).toBeLessThanOrEqual(2 * size)
        discardStructuredLaunchPrompts(SESSION)
      }
    }
  } finally {
    reads.mockRestore()
  }
})

it('replaces the catalog chat placeholder with the exact accepted terminal while the outer reply is pending, then notices a lost reply without paste', async () => {
  const { parseDesktopCreateLaunchRecord } =
    await import('../lib/structured-agent-session-launch-record')
  const { issueDesktopCreateLaunch, acceptDesktopCreateCatalog } =
    await import('../lib/structured-agent-session-desktop-create')
  const {
    writeStructuredAgentLaunchRecord,
    readStructuredAgentLaunchRecord,
    resetStructuredAgentLaunchPersistenceForTests
  } = await import('../lib/structured-agent-session-launch-persistence')
  const rpcModule = await import('./runtime-rpc-client')
  const { makeWorktree } = await import('../store/slices/worktrees-slice-test-fixtures')
  const sessionId = 'claude_11111111_2222_4333_8444_555555555555'
  const tabId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
  const instanceId = '94d38a16-e9db-4e86-b81d-334788958124'
  const operationId = `${Date.now()}-0123456789abcdef0123456789abcdef`
  const record = parseDesktopCreateLaunchRecord({
    sessionId,
    agent: 'claude',
    executionHostId: 'local',
    lifecycle: 'visibility-unknown',
    desktopCreate: {
      params: {
        agent: 'claude',
        sessionId,
        surface: 'chat',
        operationId,
        createIdentity: { instanceId },
        paneKey: `${tabId}:${LEAF}`,
        target: { kind: 'create-worktree', create: { repo: 'repo', name: 'task' } },
        prompt: { text: 'opening A', delivery: 'submit' }
      }
    }
  })
  if (!record) {
    throw new Error('outer fixture invalid')
  }
  let rejectReply!: (error: Error) => void
  const rpc = vi.spyOn(rpcModule, 'callRuntimeRpc').mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectReply = reject
      })
  )
  const notice = vi.fn()
  const draft = vi.fn()
  const prompt = stageHostCreatedLaunchPrompt({
    sessionId,
    operationId,
    paneKey: `${tabId}:${LEAF}`,
    text: 'opening A',
    delivery: 'submit',
    executionHostId: 'local',
    target: { kind: 'local' },
    agent: 'claude',
    presentDraft: draft,
    terminalNotice: notice
  })
  resetStructuredAgentLaunchPersistenceForTests()
  try {
    writeStructuredAgentLaunchRecord(record)
    const issue = issueDesktopCreateLaunch(record, { kind: 'local' })
    const lost = expect(issue).rejects.toThrow('whole reply lost')
    const row = makeWorktree({ id: WORKTREE, repoId: 'repo', instanceId })
    acceptDesktopCreateCatalog('local', [row])
    expect(
      useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKTREE]?.some((tab) => tab.entityId === sessionId)
    ).toBe(true)
    const snapshot = topology('terminal')
    for (const tab of snapshot.tabs) {
      if (tab.type === 'terminal' && tab.parentTabId === AGENT) {
        tab.parentTabId = tabId
        tab.id = `${tabId}::${LEAF}`
        tab.launchAgent = 'claude'
      }
    }
    snapshot.tabGroups = []
    snapshot.activeTabId = `${tabId}::${LEAF}`
    deliver(snapshot)
    expect(notice).not.toHaveBeenCalled()
    expect(
      useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKTREE]?.some((tab) => tab.entityId === sessionId)
    ).toBe(false)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.some((tab) => tab.id === tabId)).toBe(
      true
    )
    acceptDesktopCreateCatalog('local', [row])
    rejectReply(new Error('whole reply lost'))
    await lost
    expect(notice).toHaveBeenCalledExactlyOnceWith(tabId, LEAF, 'opening A', 'unconfirmed')
    expect(draft).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionPendingSends(sessionId)).toEqual([])
    expect(hasStagedStructuredLaunchPrompt(sessionId)).toBe(false)
    expect(readStructuredAgentLaunchRecord(sessionId)).toBeUndefined()
    acceptDesktopCreateCatalog('local', [row])
    expect(
      useAppStore
        .getState()
        .unifiedTabsByWorktree[WORKTREE]?.some((tab) => tab.entityId === sessionId)
    ).toBe(false)
    expect(rpc.mock.calls.map(([, method]) => method)).toEqual(['agent.launchReplay'])
  } finally {
    rpc.mockRestore()
    discardStructuredLaunchPrompts(sessionId)
    resetStructuredAgentLaunchPersistenceForTests()
    prompt?.createSend?.drop()
  }
})

it('bounds real ancillary reveal and final completion binding work with unrelated window terminals', async () => {
  const {
    makeTerminalTab: makeTab,
    makeWorktree,
    TEST_REPO
  } = await import('../store/slices/worktrees-slice-test-fixtures')
  const { registerTerminalPresentationIpcBridge } =
    await import('../hooks/ipc-events/terminal-presentation-ipc-bridge')
  const { materializeHostCreatedWorktree } = await import('../lib/worktree-creation-host-result')
  const { createBumpWorktreeActivity } =
    await import('../store/slices/worktrees/session/worktree-activity-bump')
  const rpcModule = await import('./runtime-rpc-client')
  const metrics: {
    size: number
    ownershipVisits: number
    bindingVisits: number
    duplicateBindingVisits: number
    persistence: number
    elapsedMs: number
    duplicateVisits: number
  }[] = []
  for (const size of [10, 100]) {
    resetLocalStructuredSessionVersionForTests()
    useAppStore.setState(useAppStore.getInitialState(), true)
    const api = createStoreSessionMockApi()
    const corpus = instrumentUnrelatedTerminalBindings(size * 10, OTHER)
    const visits = corpus.counts
    useAppStore.setState({
      activeWorktreeId: OTHER,
      activeTabId: 'unrelated-0',
      activeTabIdByWorktree: { [OTHER]: 'unrelated-0' },
      repos: [{ ...TEST_REPO, id: 'repo', executionHostId: 'local' }],
      worktreesByRepo: { repo: [makeWorktree({ id: WORKTREE, repoId: 'repo', hostId: 'local' })] },
      tabsByWorktree: { [OTHER]: corpus.tabs },
      ptyIdsByTabId: corpus.ptyIdsByTabId,
      bumpWorktreeActivity: createBumpWorktreeActivity(useAppStore.setState, useAppStore.getState)
    })
    type Reveal = Parameters<Parameters<typeof window.api.ui.onCreateTerminal>[0]>[0]
    let reveal: (payload: Reveal) => void = () => {
      throw new Error('bridge not registered')
    }
    const reply = vi.fn()
    Object.assign(window.api, {
      ui: {
        onCreateTerminal: (listener: typeof reveal) => {
          reveal = listener
          return () => {}
        },
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: reply
      }
    })
    Object.assign(window, { dispatchEvent: vi.fn() })
    registerTerminalPresentationIpcBridge([])
    const rows = Array.from({ length: size }, (_, i) => ({
      type: 'terminal' as const,
      id: `default-${i}::${LEAF}`,
      parentTabId: `default-${i}`,
      leafId: LEAF,
      title: '',
      terminal: `default-pty-${i}`,
      status: 'ready' as const,
      isActive: i === 0
    }))
    let snapshot: RuntimeMobileSessionTabsResult = {
      ...topology('terminal'),
      tabs: [],
      activeTabId: rows[0]!.id,
      tabGroups: []
    }
    const rpc = vi.spyOn(rpcModule, 'callRuntimeRpc').mockImplementation(async () => snapshot)
    visits.ownershipVisits = 0
    visits.bindingVisits = 0
    const started = performance.now()
    try {
      for (let i = 0; i < size; i++) {
        snapshot = { ...snapshot, snapshotVersion: i + 2, tabs: rows.slice(0, i + 1) }
        reveal({
          worktreeId: WORKTREE,
          requestId: `reveal-${i}`,
          tabId: `default-${i}`,
          leafId: LEAF,
          ptyId: `default-pty-${i}`,
          presentation: 'background',
          surfaceOwner: false,
          initialWorkspaceTopology: snapshot
        })
      }
      await materializeHostCreatedWorktree({ kind: 'local' }, WORKTREE)
      const incrementalVisits = visits.ownershipVisits
      const incrementalBindingVisits = visits.bindingVisits
      const persistence = api.worktrees.updateMeta.mock.calls.length
      const beforeDuplicate = visits.ownershipVisits
      const beforeDuplicateBindings = visits.bindingVisits
      const heldBindings = useAppStore.getState().ptyIdsByTabId
      const heldLayouts = useAppStore.getState().terminalLayoutsByTabId
      await materializeHostCreatedWorktree({ kind: 'local' }, WORKTREE)
      await materializeHostCreatedWorktree({ kind: 'local' }, WORKTREE)
      const duplicateVisits = visits.ownershipVisits - beforeDuplicate
      expect(useAppStore.getState().ptyIdsByTabId).toBe(heldBindings)
      expect(useAppStore.getState().terminalLayoutsByTabId).toBe(heldLayouts)
      metrics.push({
        size,
        ownershipVisits: incrementalVisits,
        bindingVisits: incrementalBindingVisits,
        duplicateBindingVisits: visits.bindingVisits - beforeDuplicateBindings,
        persistence,
        duplicateVisits,
        elapsedMs: performance.now() - started
      })
      console.log('R3R1 corpus', JSON.stringify(metrics.at(-1)))
      expect(reply.mock.calls.filter(([result]) => result.error)).toEqual([])
      expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toHaveLength(size)
      expect(useAppStore.getState().activeTabId).toBe('unrelated-0')
      // Each real reveal retains its ordinary activity effect; complete-census replay adds none.
      expect(persistence).toBe(size)
      expect(api.worktrees.updateMeta).toHaveBeenCalledTimes(size)
      expect(
        api.worktrees.updateMeta.mock.calls.every(
          ([args]) =>
            args.worktreeId === WORKTREE && typeof args.updates.lastActivityAt === 'number'
        )
      ).toBe(true)
      expect(duplicateVisits).toBeLessThanOrEqual(2 * size * 10)
      expect(visits.bindingVisits - beforeDuplicateBindings).toBeLessThanOrEqual(2 * size * 10)
      expect(incrementalBindingVisits).toBeLessThanOrEqual((size + 1) * size * 10)
      expect(incrementalVisits).toBeLessThanOrEqual((4 * size + 1) * size * 10)
      // A changed exact leaf still rebinds; conflicting ownership and a real close still win.
      api.worktrees.updateMeta.mockClear()
      snapshot = {
        ...snapshot,
        snapshotVersion: size + 3,
        tabs: rows.map((row, i) =>
          i === 0 && row.type === 'terminal' ? { ...row, terminal: 'rotated-pty' } : row
        )
      }
      await materializeHostCreatedWorktree({ kind: 'local' }, WORKTREE)
      expect(
        useAppStore.getState().terminalLayoutsByTabId['default-0']?.ptyIdsByLeafId?.[LEAF]
      ).toBe('rotated-pty')
      expect(api.worktrees.updateMeta).toHaveBeenCalledTimes(1)
      useAppStore.setState((state) => ({
        ptyIdsByTabId: { ...state.ptyIdsByTabId, 'unrelated-0': ['collision-pty'] }
      }))
      snapshot = {
        ...snapshot,
        snapshotVersion: size + 4,
        tabs: rows.map((row, i) =>
          i === 1 && row.type === 'terminal' ? { ...row, terminal: 'collision-pty' } : row
        )
      }
      const beforeCollision = api.worktrees.updateMeta.mock.calls.length
      await materializeHostCreatedWorktree({ kind: 'local' }, WORKTREE)
      expect(
        useAppStore.getState().terminalLayoutsByTabId['default-1']?.ptyIdsByLeafId?.[LEAF]
      ).toBe('default-pty-1')
      // Row zero returns to its original PTY; only that real change may stamp activity.
      expect(api.worktrees.updateMeta.mock.calls.length - beforeCollision).toBe(1)
      recordWebSessionCloseIntent(
        { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
        WORKTREE,
        'default-2',
        Date.now()
      )
      useAppStore.getState().closeTab('default-2', { reason: 'user' })
      const beforeClose = api.worktrees.updateMeta.mock.calls.length
      snapshot = { ...snapshot, snapshotVersion: size + 5 }
      await materializeHostCreatedWorktree({ kind: 'local' }, WORKTREE)
      expect(
        useAppStore.getState().tabsByWorktree[WORKTREE]?.some((tab) => tab.id === 'default-2')
      ).toBe(false)
      expect(api.worktrees.updateMeta).toHaveBeenCalledTimes(beforeClose)
      useAppStore.setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [OTHER]: [
            ...state.tabsByWorktree[OTHER]!,
            makeTab({ id: 'default-3', worktreeId: OTHER })
          ],
          [WORKTREE]: [
            ...state.tabsByWorktree[WORKTREE]!,
            makeTab({ id: 'orphan', worktreeId: WORKTREE })
          ]
        }
      }))
      const extra = (tabId: string, ptyId: string) => ({
        type: 'terminal' as const,
        id: `${tabId}::${LEAF}`,
        parentTabId: tabId,
        leafId: LEAF,
        terminal: ptyId,
        title: '',
        status: 'ready' as const,
        isActive: false
      })
      snapshot = {
        ...snapshot,
        snapshotVersion: size + 6,
        tabs: [
          ...snapshot.tabs.map((row) =>
            row.type === 'terminal' && row.status === 'ready' && row.parentTabId === 'default-3'
              ? { ...row, terminal: 'duplicate-owner-pty' }
              : row
          ),
          extra('new-default', 'new-default-pty'),
          extra('orphan', 'returned-orphan-pty')
        ]
      }
      await materializeHostCreatedWorktree({ kind: 'local' }, WORKTREE)
      expect(
        useAppStore.getState().terminalLayoutsByTabId['default-3']?.ptyIdsByLeafId?.[LEAF]
      ).toBe('default-pty-3')
      expect(useAppStore.getState().terminalLayoutsByTabId.orphan?.ptyIdsByLeafId?.[LEAF]).toBe(
        'returned-orphan-pty'
      )
      expect(api.worktrees.updateMeta).toHaveBeenCalledTimes(beforeClose)
    } finally {
      rpc.mockRestore()
    }
  }
  expect(metrics[1]!.ownershipVisits).toBeLessThanOrEqual(metrics[0]!.ownershipVisits * 115)
  expect(metrics[1]!.duplicateVisits).toBeLessThanOrEqual(metrics[0]!.duplicateVisits * 11)
})
