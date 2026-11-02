// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { Tab } from '../../../../shared/tab-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-attention-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const transport = vi.hoisted(() => ({
  bridge: vi.fn(),
  subscribe: vi.fn(),
  focusRenderer: vi.fn(() => false),
  subscriptions: new Map<string, (event: AgentSessionStatusEvent) => void>(),
  unsupported: false,
  olderLookup: false,
  /** Holds server-1's repo catalog reply until released, as a cold or reconnecting window sees it. */
  catalog: null as Promise<void> | null,
  catalogFails: false,
  /** Where the host says the chat is before a reveal places it. */
  locatedAt: null as string | null
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  ...moduleFactories.structuredAgentSessionClient(),
  subscribeStructuredAgentSessionStatus: transport.subscribe
}))
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => ({
    settings: null,
    worktreeId: 'repo-1::/repo',
    worktreePath: '/repo'
  })
}))
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('./NativeChatPaneFileDropSurface', () => ({
  NativeChatPaneFileDropSurface: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../tab-group/RetainedPaneHost', () => ({
  RetainedPaneHost: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  focusRendererTerminalHandle: transport.focusRenderer
}))

import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'
import * as sleepingResume from '@/lib/resume-sleeping-agent-session'
import * as openExistingStructuredSession from '@/lib/open-existing-structured-session'
import { structuredSessionOpenFeedback } from '@/lib/activate-ai-vault-structured-session'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import * as droppedRows from '@/store/repos/dropped-repo-worktree-rows'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { collectionVisits } from '../../../../shared/collection-visits.test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'

// The same checkout registered on this app and on server-1: one workspace ID on two hosts.
const WORKSPACE = 'repo-1::/repo'
const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1
}
const REMOTE_REPO: Repo = { ...REPO, executionHostId: 'runtime:server-1' }
const row = (hostId: 'local' | 'runtime:server-1') =>
  makeWorktree({ id: WORKSPACE, repoId: 'repo-1', path: '/repo', hostId, isMainWorktree: true })
const ROOT = testOrcaSessionId('root-chat')
const initial = useAppStore.getInitialState()
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
let restoreViewport = () => {}
let wakes: ReturnType<typeof vi.spyOn>
/** server-1's own answers: its registered repo, its listing of that checkout, and its reveal. */
const serverCatalog: Record<string, unknown> = {
  'repo.list': { repos: [REPO] },
  'worktree.detectedList': {
    repoId: 'repo-1',
    authoritative: true,
    source: 'git',
    worktrees: [
      {
        ...row('runtime:server-1'),
        ownership: 'orca-managed',
        selectedCheckout: true,
        visible: true
      }
    ]
  },
  'agentSession.reveal': { ok: true, sessionId: ROOT, workspaceId: WORKSPACE, agent: 'claude' }
}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())

function tab(id: string, sessionId: string, name: string, host: 'local' | 'runtime:server-1'): Tab {
  return {
    id,
    entityId: sessionId,
    customLabel: name,
    executionHostId: host,
    worktreeId: WORKSPACE,
    groupId: 'group',
    contentType: 'agent-session',
    label: 'Claude Chat',
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function source(terminal = false): AgentMessageSource {
  const address = terminal ? 'term-sender' : `orca_session_id:${ROOT}`
  return {
    kind: 'agent',
    senders: [
      {
        party: {
          address,
          terminalHandle: terminal ? address : null,
          orcaSessionId: terminal ? null : ROOT
        },
        name: 'Recorded sender'
      }
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'run:r1',
      dispatchId: null,
      messages: [{ messageId: 'mail-1', runId: 'r1', from: address }]
    }
  }
}
/** `listed` names the hosts whose workspace listing this window already holds. */
function seed(
  duplicate = false,
  terminal = false,
  listed: readonly ('local' | 'runtime:server-1')[] = ['local', 'runtime:server-1']
): void {
  const from = source(terminal)
  mocks.messages = [
    {
      id: 'mail',
      role: 'user',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Agent mail' }],
      from
    }
  ]
  mocks.queuedCards = [
    { messageId: 'queued', position: 1, text: 'Agent mail', state: 'waiting', hold: 'turn', from }
  ]
  useAppStore.setState(
    {
      ...initial,
      activeWorktreeId: WORKSPACE,
      activeWorkspaceExecutionHostId: 'local',
      activeView: 'terminal',
      repos: listed.includes('runtime:server-1') ? [REPO, REMOTE_REPO] : [REPO],
      worktreesByRepo: { 'repo-1': listed.map(row) },
      focusGroup: vi.fn(),
      activateTab: vi.fn(),
      setActiveTabType: vi.fn(),
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          {
            ...tab('recipient', 'recipient-chat', 'Recipient', 'runtime:server-1'),
            agentSessionAgent: 'claude'
          },
          tab('remote-sender', ROOT, 'Remote rename', 'runtime:server-1'),
          tab('local-sender', duplicate ? ROOT : 'local-chat', 'Wrong local name', 'local')
        ]
      },
      groupsByWorktree: {
        [WORKSPACE]: [
          { id: 'group', worktreeId: WORKSPACE, activeTabId: 'recipient', tabOrder: ['recipient'] }
        ]
      },
      activeGroupIdByWorktree: { [WORKSPACE]: 'group' }
    },
    true
  )
}
async function mount(): Promise<ReturnType<typeof render>> {
  let view: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <TooltipProvider>
        <StructuredAgentSessionPaneOverlayLayer worktreeId={WORKSPACE} isWorktreeActive />
      </TooltipProvider>
    )
  })
  return view!
}
function publish(host: string, sessionId: string = ROOT): void {
  transport.subscriptions.get(host)?.({
    type: 'snapshot',
    sessions: [
      {
        sessionId,
        workspaceId: WORKSPACE,
        agent: 'claude',
        status: null,
        latestPrompt: '',
        updatedAt: 1
      }
    ]
  })
}

beforeEach(() => {
  resetStructuredSessionMocks()
  resetStructuredAgentSessionStatusFeedsForTests()
  clearRuntimeCompatibilityCacheForTests()
  transport.subscriptions.clear()
  transport.subscribe.mockReset()
  transport.focusRenderer.mockClear()
  transport.unsupported = false
  transport.olderLookup = false
  transport.catalog = null
  transport.catalogFails = false
  transport.locatedAt = null
  wakes = vi.spyOn(sleepingResume, 'resumeSleepingAgentSessionsForWorktree').mockReturnValue(0)
  transport.subscribe.mockImplementation(
    async (target: RuntimeClientTarget, emit: (event: AgentSessionStatusEvent) => void) => {
      const host = target.kind === 'local' ? 'local' : target.environmentId
      transport.subscriptions.set(host, emit)
      return { unsubscribe: vi.fn(() => transport.subscriptions.delete(host)) }
    }
  )
  transport.bridge.mockReset()
  transport.bridge.mockImplementation(
    async ({ method, params }: { method: string; params?: { address?: string } }) => {
      if (method === 'repo.list') {
        await transport.catalog
        if (transport.catalogFails) {
          return { id: 'reply', ok: false, error: { code: 'unavailable', message: 'offline' } }
        }
      }
      if (method === 'orchestration.partyLocation' && transport.olderLookup) {
        return {
          id: 'reply',
          ok: false,
          error: { code: 'method_not_found', message: 'older host' },
          _meta: { runtimeId: 'remote' }
        }
      }
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
              capabilities: transport.unsupported
                ? []
                : [
                    AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
                    STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY
                  ]
            }
          : method === 'orchestration.partyLocation'
            ? {
                location:
                  params?.address === 'term-sender'
                    ? { kind: 'terminal', handle: 'term-current' }
                    : {
                        kind: 'chat',
                        sessionId: ROOT,
                        worktreeId: transport.locatedAt ?? WORKSPACE
                      }
              }
            : (serverCatalog[method] ?? { ok: true })
      return { id: 'reply', ok: true, result, _meta: { runtimeId: 'remote' } }
    }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...window.api,
      runtime: { call: transport.bridge },
      runtimeEnvironments: { call: transport.bridge }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetStructuredAgentSessionStatusFeedsForTests()
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState(initial, true)
  if (previousApi) {
    Object.defineProperty(window, 'api', previousApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it.each([false, true])(
  'uses the stamped recipient host through queue/transcript names, renames and chat clicks (duplicate IDs %s)',
  async (duplicate) => {
    seed(duplicate)
    const stopLocal = getStructuredAgentSessionStatusFeed({ kind: 'local' }).activate()
    await mount()
    act(() => {
      publish('local', duplicate ? ROOT : 'local-chat')
      publish('server-1')
    })
    expect(screen.getAllByRole('button', { name: 'Remote rename' })).toHaveLength(2)
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [WORKSPACE]: useAppStore
            .getState()
            .unifiedTabsByWorktree[WORKSPACE]!.map((t) =>
              t.id === 'remote-sender' ? { ...t, customLabel: 'Updated remote rename' } : t
            )
        }
      })
    )
    const links = screen.getAllByRole('button', { name: 'Updated remote rename' })
    for (const link of links) {
      await act(async () => fireEvent.click(link))
      expect(transport.bridge).toHaveBeenCalledWith(
        expect.objectContaining({ selector: 'server-1', method: 'orchestration.partyLocation' })
      )
      expect(transport.bridge).toHaveBeenCalledWith(
        expect.objectContaining({ selector: 'server-1', method: 'session.tabs.activate' })
      )
      expect(useAppStore.getState().activateTab).toHaveBeenLastCalledWith('remote-sender', {
        worktreeId: WORKSPACE
      })
      expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:server-1')
    }
    // Both hosts listed and the local one on screen: the first click switches to server-1 and
    // wakes it once; the second finds it on screen and wakes nothing.
    expect(wakes.mock.calls.map(([worktreeId]) => worktreeId)).toEqual([WORKSPACE])
    expect(transport.bridge).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'repo.list' })
    )
    stopLocal()
  }
)

it('keeps recorded CLI labels and focuses the exact remote pane from both surfaces', async () => {
  seed(false, true)
  await mount()
  for (const link of screen.getAllByRole('button', { name: 'Recorded sender' })) {
    await act(async () => fireEvent.click(link))
    expect(transport.focusRenderer).toHaveBeenLastCalledWith('term-current', 'server-1')
    expect(transport.bridge).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'server-1',
        method: 'terminal.focus',
        params: { terminal: 'term-current', navigation: 'host' }
      })
    )
  }
})

it('keeps older-host direct-root names and both clicks on the stamped host when the workspace is local', async () => {
  // This window lists only its own copy; the older host's listing loads on the click, with no reveal.
  seed(false, false, ['local'])
  transport.unsupported = true
  transport.olderLookup = true
  useAppStore.setState({
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        useAppStore.getState().unifiedTabsByWorktree[WORKSPACE]![0]!,
        tab('wrong-local', ROOT, 'Wrong local name', 'local'),
        tab('remote-sender', ROOT, 'Legacy remote rename', 'runtime:server-1')
      ]
    }
  })
  await mount()
  for (const link of screen.getAllByRole('button', { name: 'Legacy remote rename' })) {
    vi.mocked(useAppStore.getState().activateTab).mockClear()
    await act(async () => fireEvent.click(link))
    await vi.waitFor(() =>
      expect(useAppStore.getState().activateTab).toHaveBeenLastCalledWith('remote-sender', {
        worktreeId: WORKSPACE
      })
    )
    expect(transport.bridge).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'server-1', method: 'session.tabs.activate' })
    )
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:server-1')
  }
  expect(calls('agentSession.reveal')).toBe(0)
  expect(calls('repo.list')).toBe(1)
  expect(wakes).toHaveBeenCalledOnce()
})

const calls = (method: string): number =>
  transport.bridge.mock.calls.filter(([request]) => request.method === method).length
const remoteLink = () => screen.getAllByRole('button', { name: 'Remote rename' })[0]!

it('finishes the click once server-1 lists the workspace this window had not loaded yet', async () => {
  seed(false, false, ['local'])
  let release = () => {}
  transport.catalog = new Promise((resolve) => (release = resolve))
  const unavailable = vi.spyOn(structuredSessionOpenFeedback, 'unavailable')
  await mount()
  await act(async () => fireEvent.click(remoteLink()))
  await vi.waitFor(() => expect(calls('repo.list')).toBe(1))
  // Waiting on the owner's catalog: nothing failed, switched, woke or activated yet.
  expect(unavailable).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')
  expect(useAppStore.getState().activateTab).not.toHaveBeenCalled()
  expect(wakes).not.toHaveBeenCalled()
  await act(async () => release())
  await vi.waitFor(() =>
    expect(useAppStore.getState().activateTab).toHaveBeenLastCalledWith('remote-sender', {
      worktreeId: WORKSPACE
    })
  )
  const state = useAppStore.getState()
  // Admitted through the store's own listing, then selected on its host.
  expect(state.worktreesByRepo['repo-1']?.map((entry) => entry.hostId)).toContain(
    'runtime:server-1'
  )
  expect(state.activeWorkspaceExecutionHostId).toBe('runtime:server-1')
  expect(transport.bridge).toHaveBeenCalledWith(
    expect.objectContaining({ selector: 'server-1', method: 'session.tabs.activate' })
  )
  expect(wakes).toHaveBeenCalledOnce()
  expect(unavailable).not.toHaveBeenCalled()
  expect(calls('agentSession.reveal')).toBe(0)
})

// Each population gets its own store, so the 20 and 200 cases compare their store updates here.
const staleUpdates = new Map<number, number>()
it.each([20, 200])(
  "prepares server-1's cold catalog once per open beside %i stale registrations, keeping other owners",
  async (stale) => {
    seed(false, false, ['local'])
    // server-1 no longer registers `stale` projects this window still lists, each with a listed and
    // a detected checkout there, nor `shared`, which this machine still registers too. `foreign`
    // is this machine's alone.
    const remote = (id: string, path: string): Repo => ({
      ...REPO,
      id,
      path,
      executionHostId: 'runtime:server-1'
    })
    const staleRepos = Array.from({ length: stale }, (_, i) => remote(`stale-${i}`, `/stale/${i}`))
    const checkout = (repoId: string, path: string, hostId: 'local' | 'runtime:server-1') =>
      makeWorktree({ id: `${repoId}::${path}`, repoId, path, hostId })
    const detected = (repoId: string, worktrees: ReturnType<typeof checkout>[]) => ({
      repoId,
      authoritative: true,
      source: 'git' as const,
      worktrees: worktrees.map((entry) => ({
        ...entry,
        ownership: 'orca-managed' as const,
        selectedCheckout: false,
        visible: true
      }))
    })
    const foreignRows = [checkout('foreign', '/foreign', 'local')]
    const foreignDetected = detected('foreign', foreignRows)
    const sharedLocal = checkout('shared', '/shared', 'local')
    const seeded = useAppStore.getState()
    useAppStore.setState({
      repos: [
        ...seeded.repos,
        { ...REPO, id: 'foreign', path: '/foreign' },
        { ...REPO, id: 'shared', path: '/shared' },
        remote('shared', '/shared'),
        ...staleRepos
      ],
      worktreesByRepo: {
        ...seeded.worktreesByRepo,
        foreign: foreignRows,
        shared: [sharedLocal, checkout('shared', '/shared-remote', 'runtime:server-1')],
        ...Object.fromEntries(
          staleRepos.map((repo) => [repo.id, [checkout(repo.id, repo.path, 'runtime:server-1')]])
        )
      },
      detectedWorktreesByRepo: {
        foreign: foreignDetected,
        ...Object.fromEntries(
          staleRepos.map((repo) => [
            repo.id,
            detected(repo.id, [checkout(repo.id, `${repo.path}-detected`, 'runtime:server-1')])
          ])
        )
      }
    })
    // The pruner the catalog's adoption runs, with what it is given. Its body checks every dropped
    // project for each one with detected checkouts (dropped-repo-worktree-rows.ts:66-73), an
    // unchanged main cost: its visits are reported, not bounded here.
    const pruner = { calls: 0, previous: 0, next: 0, dropped: 0, detected: 0, rows: 0, visits: 0 }
    const prune = droppedRows.dropWorktreeRowsOfDroppedRepos
    vi.spyOn(droppedRows, 'dropWorktreeRowsOfDroppedRepos').mockImplementation(
      (rows, previous, next) => {
        const kept = new Set(next.map(getRepoHostIdentity))
        const dropped = new Set(
          previous.filter((repo) => !kept.has(getRepoHostIdentity(repo))).map((repo) => repo.id)
        )
        pruner.calls++
        pruner.previous += previous.length
        pruner.next += next.length
        pruner.dropped += dropped.size
        for (const repoId of dropped) {
          pruner.detected += rows.detectedWorktreesByRepo[repoId]?.worktrees.length ?? 0
          pruner.rows += rows.worktreesByRepo[repoId]?.length ?? 0
        }
        const pruned = collectionVisits(() => prune(rows, previous, next))
        pruner.visits += pruned.visits
        return pruned.value
      }
    )
    let release = () => {}
    transport.catalog = new Promise((resolve) => (release = resolve))
    const opens = vi.spyOn(openExistingStructuredSession, 'openDesktopStructuredSessionInteraction')
    await mount()
    const before = useAppStore.getState()
    let updates = 0
    const unsubscribe = useAppStore.subscribe(() => updates++)
    await act(async () => fireEvent.click(remoteLink()))
    await vi.waitFor(() => expect(calls('repo.list')).toBe(1))
    await act(async () => release())
    await act(async () => {
      await opens.mock.results[0]!.value
    })
    unsubscribe()
    const after = useAppStore.getState()
    console.log('S4_PRUNER_MAIN_COST', JSON.stringify({ stale, ...pruner, updates }))
    // The open prepared server-1 once: one catalog, one adoption pruning it, one listing.
    expect({
      refreshes: calls('repo.list'),
      listings: calls('worktree.detectedList'),
      prunes: pruner.calls
    }).toEqual({ refreshes: 1, listings: 1, prunes: 1 })
    // What the pruner was given: the store's projects and the catalog's, and the dropped ones'
    // rows; nothing per chat or per stale row.
    expect({ dropped: pruner.dropped, detected: pruner.detected, rows: pruner.rows }).toEqual({
      dropped: stale + 1,
      detected: stale,
      rows: stale + 2
    })
    expect(pruner.previous).toBe(before.repos.length)
    expect(pruner.next).toBeLessThanOrEqual(before.repos.length)
    // The exact chat on its own host.
    expect(after.activateTab).toHaveBeenLastCalledWith('remote-sender', { worktreeId: WORKSPACE })
    expect(after.activeWorkspaceExecutionHostId).toBe('runtime:server-1')
    expect(wakes).toHaveBeenCalledOnce()
    // server-1's stale rows are gone; this machine's rows stay, and `foreign` is untouched.
    for (const repo of staleRepos) {
      expect(after.worktreesByRepo[repo.id] ?? []).toEqual([])
      expect(after.detectedWorktreesByRepo[repo.id]?.worktrees ?? []).toEqual([])
    }
    expect(after.worktreesByRepo.shared).toEqual([sharedLocal])
    expect(after.worktreesByRepo.foreign).toBe(foreignRows)
    expect(after.detectedWorktreesByRepo.foreign).toBe(foreignDetected)
    staleUpdates.set(stale, updates)
    if (stale === 200) {
      // The open's store updates do not grow with the stale registrations.
      expect(updates).toBe(staleUpdates.get(20) ?? updates)
    }
    // Opening the same chat again finds it listed: no second preparation.
    await act(async () => fireEvent.click(remoteLink()))
    await act(async () => {
      await opens.mock.results[1]!.value
    })
    expect({ refreshes: calls('repo.list'), prunes: pruner.calls }).toEqual({
      refreshes: 1,
      prunes: 1
    })
  }
)

it('lists the destination a reveal returns before showing it', async () => {
  seed(false, false, ['local'])
  // The host still records the chat under its old project until the reveal places it.
  transport.locatedAt = 'retired-project::/old'
  await mount()
  await act(async () => fireEvent.click(remoteLink()))
  await vi.waitFor(() =>
    expect(useAppStore.getState().activateTab).toHaveBeenLastCalledWith('remote-sender', {
      worktreeId: WORKSPACE
    })
  )
  expect(calls('agentSession.reveal')).toBe(1)
  expect(calls('repo.list')).toBe(1)
  expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:server-1')
  expect(wakes).toHaveBeenCalledOnce()
})

it('wakes and selects nothing when server-1 cannot list the workspace', async () => {
  seed(true, false, ['local'])
  transport.catalogFails = true
  const unavailable = vi.spyOn(structuredSessionOpenFeedback, 'unavailable')
  await mount()
  await act(async () => fireEvent.click(remoteLink()))
  await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce())
  const state = useAppStore.getState()
  expect(state.activeWorkspaceExecutionHostId).toBe('local')
  // Neither the remote chat nor the same-ID local copy is shown.
  expect(state.activateTab).not.toHaveBeenCalled()
  expect(wakes).not.toHaveBeenCalled()
  // One load per destination, however many times the opener retries showing it.
  expect(calls('repo.list')).toBe(1)
})

it.each([
  {
    went: 'another workspace',
    go: () => useAppStore.setState({ activeWorktreeId: 'repo-1::/elsewhere' }),
    view: 'terminal',
    worktree: 'repo-1::/elsewhere'
  },
  // Settings changes only the page shown, not the workspace, its host or a dialog.
  {
    went: 'Settings',
    go: () => useAppStore.getState().openSettingsPage(),
    view: 'settings',
    worktree: WORKSPACE
  }
])(
  'leaves the user in $went, where they went while server-1 was still listing the workspace',
  async ({ go, view, worktree }) => {
    seed(false, false, ['local'])
    let release = () => {}
    transport.catalog = new Promise((resolve) => (release = resolve))
    const unavailable = vi.spyOn(structuredSessionOpenFeedback, 'unavailable')
    const opens = vi.spyOn(openExistingStructuredSession, 'openDesktopStructuredSessionInteraction')
    await mount()
    await act(async () => fireEvent.click(remoteLink()))
    await vi.waitFor(() => expect(calls('repo.list')).toBe(1))
    act(go)
    await act(async () => release())
    // The open itself settles; nothing it did afterwards can move the user.
    await act(async () => {
      await opens.mock.results[0]!.value
    })
    expect(calls('worktree.detectedList')).toBe(1)
    const state = useAppStore.getState()
    expect({
      view: state.activeView,
      worktree: state.activeWorktreeId,
      host: state.activeWorkspaceExecutionHostId,
      activated: vi.mocked(state.activateTab).mock.calls.length,
      woken: wakes.mock.calls.length
    }).toEqual({ view, worktree, host: 'local', activated: 0, woken: 0 })
    expect(unavailable).not.toHaveBeenCalled()
    expect(calls('agentSession.reveal')).toBe(0)
  }
)
