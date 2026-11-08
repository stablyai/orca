/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { HostAuthority } from '../../src/shared/host-authority'
import type { AgentStatusEntry } from '../../src/shared/agent-status/contracts/agent-status-types'
import type { ClaudeAgentViewResult } from '../../src/shared/claude-agent-view'
import { TerminalViewClaudeAgent } from '../../src/shared/rpc-contract/terminal-unary-params'
import { createHookListenerState } from '../../src/shared/agent-hook-listener/listener-state'
import { seedClaudeSubagentRosterFromSnapshots } from '../../src/shared/agent-hook-listener/providers/claude-roster-state'
import { claudeRosterToSnapshots } from '../../src/shared/claude-subagent-roster'
import { decodeAgentSubagentsField } from '../../src/shared/agent-status/contracts/agent-status-subagent-snapshot'
import { makePaneKey } from '../../src/shared/workspace-layout/stable-pane-id'
import { ClaudeAgentViewBridge } from '../../src/main/claude/agent-view/agent-view-bridge'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { RUNTIME_PROTOCOL_VERSION } from '../../src/shared/protocol-version'
import { buildSubagentChildRows } from '@/components/sidebar/workspace-card/activity/worktree-subagent-child-rows'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompactAgentRow } from '@/components/sidebar/workspace-card/activity/worktree-card-compact-agent-row'
import FullAgentRow from '@/components/dashboard/DashboardAgentRow'
import { opensClaudeParentConversation, viewClaudeAgentFromRow } from '@/lib/claude-agent-row-view'
import type * as WorktreeRuntimeOwner from '@/lib/workspace/ownership/worktree-runtime-owner'
import '@/store/slices/worktrees/worktree.test-fixture'
import '@/store/repos/repo.test-fixture'
import '@/components/sidebar/workspace-card/activity/WorktreeCardAgents'
import { i18n, translate } from '@/i18n/i18n'

const mocks = vi.hoisted(() => ({ info: vi.fn(), transport: vi.fn(), owner: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: mocks.info } }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn(),
  activateAndRevealWorkspace: vi.fn()
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('@/lib/terminal-tab-owner-activation', () => ({ activateTerminalTabOnOwner: vi.fn() }))
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: vi.fn()
}))
vi.mock('@/components/terminal-pane/agent-status/stale-agent-row', () => ({
  dismissStaleAgentRowByKey: vi.fn()
}))
vi.mock('@/hooks/use-now', () => ({ useNow: () => 1000 }))
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({})) }
})
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwner>()),
  resolveOwnerOrLocal: mocks.owner
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-environment-call', () => ({
  callRuntimeEnvironmentWithRevision: (args: {
    method: string
    params: unknown
    signal?: AbortSignal
  }) => mocks.transport(args.method, args.params, args.signal)
}))
vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))
vi.mock('@/components/sidebar/comment-markdown-lazy', () => ({
  preloadCommentMarkdown: () => {},
  CommentMarkdownAsync: () => null
}))
vi.mock('@/components/sidebar/workspace-card/activity/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey('parent-tab', leafId)
const parent: DashboardAgentRow = {
  paneKey,
  entry: {
    paneKey,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'P' },
    state: 'working',
    prompt: 'Parent',
    updatedAt: 1000,
    stateStartedAt: 1000,
    stateHistory: []
  },
  tab: {
    id: 'parent-tab',
    worktreeId: 'repo::/project',
    ptyId: 'pty',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1000
  },
  agentType: 'claude',
  state: 'working',
  startedAt: 1000
}
const keybindings = JSON.stringify({
  bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
})
type Request = ReturnType<typeof TerminalViewClaudeAgent.parse>
let bridge: ClaudeAgentViewBridge
let requests: Request[]
let root: Root | undefined
let host: HTMLDivElement
let owner: HostAuthority
let listeners: number
let forced: ClaudeAgentViewResult | Error | undefined
let missingTerminal: boolean
let signals: AbortSignal[]
let delayList: ReturnType<typeof deferred> | undefined
let delayStatus: ReturnType<typeof deferred> | undefined
let delayedResponse: { agentId: string; gate: ReturnType<typeof deferred> } | undefined

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function identity(key = paneKey) {
  return { paneKey: key, sessionId: 'P', instanceId: key }
}
function observe(agentId?: string, key = paneKey, revision = 2) {
  bridge.receive({
    ...identity(key),
    action: 'observe',
    view: { revision, ...(agentId ? { agentId } : {}) }
  })
}
function takeAndSettle(deny?: string, key = paneKey) {
  const taken = bridge.receive({ ...identity(key), action: 'take' })
  expect(taken.requestId).toBeDefined()
  expect(bridge.receive({ ...identity(key), action: 'take' })).toEqual({})
  bridge.receive({ ...identity(key), ...taken, action: 'ack', ...(deny ? { deny } : {}) })
  return taken
}
function child(shape: 'modern' | 'legacy' | 'restored', agentType?: string, id = 'W') {
  const entry: AgentStatusEntry = {
    ...parent.entry,
    subagents: decodeAgentSubagentsField([{ id, agentType, state: 'working', startedAt: 1000 }])
  }
  if (shape === 'restored') {
    const state = createHookListenerState()
    seedClaudeSubagentRosterFromSnapshots(state, paneKey, entry.subagents ?? [])
    entry.subagents = claudeRosterToSnapshots(state.claudeSubagentRosterByPaneKey.get(paneKey))
  }
  if (shape === 'modern') {
    entry.children = [
      {
        id: `host-${id}`,
        providerId: id,
        kind: 'agent',
        agentType,
        state: 'working',
        membership: 'live',
        firstObservedAt: 1000,
        observedAt: 1000,
        stoppable: false,
        invocation: { invocationId: 'turn', generation: 1 }
      }
    ]
  }
  const row = buildSubagentChildRows({
    parentEntry: entry,
    tab: parent.tab,
    parentIsFresh: true
  })[0]
  if (!row) {
    throw new Error('Expected production child projection')
  }
  return row
}
function rows(layout: 'compact' | 'full', workflow: DashboardAgentRow) {
  const activate = vi.fn()
  act(() => {
    root = createRoot(host)
    root.render(
      createElement(
        TooltipProvider,
        null,
        [parent, child('legacy', 'general-purpose', 'A'), workflow].map((agent, index) =>
          createElement(
            'section',
            { key: index, 'data-test-row': String(index) },
            layout === 'compact'
              ? createElement(CompactAgentRow, {
                  agent,
                  now: 1000,
                  parentConversationDescription: opensClaudeParentConversation(agent)
                    ? translate(
                        'auto.lib.claudeAgentRowView.openParentConversation',
                        'Open parent conversation'
                      )
                    : undefined,
                  onActivate: activate,
                  cacheTimerActive: false
                })
              : createElement(FullAgentRow, {
                  agent,
                  now: 1000,
                  onActivate: activate,
                  onDismiss: () => {},
                  hideExpand: true,
                  hideIdentityIcon: true
                })
          )
        )
      )
    )
  })
  return activate
}
function element(index: number) {
  const row = host.querySelector(`[data-test-row="${index}"] > div`)
  if (!row) {
    throw new Error('Missing source row')
  }
  return row
}
async function click(index: number) {
  await act(async () => {
    element(index).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const actualOwner = await vi.importActual<typeof WorktreeRuntimeOwner>(
  '@/lib/workspace/ownership/worktree-runtime-owner'
)

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  forced = undefined
  missingTerminal = false
  delayList = undefined
  delayStatus = undefined
  delayedResponse = undefined
  owner = { endpoint: { kind: 'self' }, at: 'local' }
  mocks.owner.mockImplementation(actualOwner.resolveOwnerOrLocal)
  replaceRuntimeEnvironmentRevisions([{ id: 'remote', createdAt: 1, pairingRevision: 1 }])
  bridge = new ClaudeAgentViewBridge()
  requests = []
  signals = []
  listeners = 0
  bridge.receive({
    ...identity(),
    action: 'register',
    keybindings,
    view: { agentId: 'A', revision: 1 }
  })
  useAppStore.setState({
    agentStatusByPaneKey: { [paneKey]: parent.entry },
    terminalLayoutsByTabId: {},
    activeWorktreeId: parent.tab.worktreeId,
    activeWorkspaceExecutionHostId: null,
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    repos: [],
    agentActivityDisplayMode: 'compact',
    acknowledgedAgentsByPaneKey: {},
    agentSendPopoverTargetMode: null,
    agentStatusEpoch: 0,
    activeTabType: 'terminal',
    activeTabId: parent.tab.id,
    tabsByWorktree: { [parent.tab.worktreeId]: [parent.tab] },
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeEnvironments: []
  })
  mocks.transport.mockImplementation(
    async (method: string, params: unknown, signal?: AbortSignal) => {
      if (signal) {
        signals.push(signal)
      }
      if (method === 'status.get') {
        await delayStatus?.promise
        return {
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION
          }
        }
      }
      if (method === 'terminal.list') {
        await delayList?.promise
        return {
          ok: true,
          result: {
            terminals: missingTerminal
              ? []
              : [
                  { handle: 'T', tabId: parent.tab.id, leafId },
                  { handle: 'T2', tabId: 'second-tab', leafId }
                ]
          }
        }
      }
      expect(method).toBe('terminal.viewClaudeAgent')
      const request = TerminalViewClaudeAgent.parse(params)
      requests.push(request)
      if (forced instanceof Error) {
        throw forced
      }
      let view = forced
      if (!view) {
        view = await bridge.view({
          paneKey: request.terminal === 'T' ? paneKey : makePaneKey('second-tab', leafId),
          sessionId: request.sessionId,
          agentId: request.agentId,
          trigger: async () => true
        })
      }
      if (delayedResponse && delayedResponse.agentId === request.agentId) {
        await delayedResponse.gate.promise
      }
      return { ok: true, result: { view } }
    }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        call: ({ method, params }: { method: string; params: unknown }) =>
          mocks.transport(method, params),
        subscribe: (_args: unknown, onResponse: (response: unknown) => void) => {
          listeners++
          const stop = bridge.subscribe((snapshot) => onResponse({ ok: true, result: snapshot }))
          return {
            unsubscribe: () => {
              listeners--
              stop()
            }
          }
        }
      }
    }
  })
  host = document.createElement('div')
  document.body.append(host)
})
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  bridge.clear()
  host.remove()
  expect(listeners).toBe(0)
})

it('settles real child and parent refusals once while observed A remains current', async () => {
  const workflow = child('restored')
  rows('compact', workflow)
  expect(element(1).getAttribute('aria-current')).toBe('true')
  const action = viewClaudeAgentFromRow(workflow)
  await act(async () => {})
  expect(requests.map((request) => request.agentId)).toEqual(['W'])
  let childRequestId: string | undefined
  await act(async () => {
    childRequestId = takeAndSettle('no agent under that id').requestId
  })
  expect(requests.map((request) => request.agentId)).toEqual(['W', undefined])
  expect(requests[1]).toEqual({ ...requests[0], agentId: undefined })
  expect(requests[1]).not.toHaveProperty('agentId')
  expect(mocks.info).not.toHaveBeenCalled()
  await act(async () => {
    const refusedParent = takeAndSettle('raw parent refusal')
    expect(refusedParent.requestId).not.toBe(childRequestId)
    expect(refusedParent.agentId).toBeUndefined()
    await action
  })
  expect(requests).toHaveLength(2)
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
    'Claude could not open the parent conversation. Try again in the Claude pane.'
  )
  expect(element(1).getAttribute('aria-current')).toBe('true')
  expect(element(0).hasAttribute('aria-current')).toBe(false)
  expect(element(2).hasAttribute('aria-current')).toBe(false)
  expect(bridge.receive({ ...identity(), action: 'take' })).toEqual({})
})

it.each(['compact', 'full'] as const)(
  'runs real %s clicks through child deny, parent take/ACK and observed selection',
  async (layout) => {
    const workflow = child('restored')
    const activate = rows(layout, workflow)
    expect(element(1).getAttribute('aria-current')).toBe('true')
    await click(2)
    expect(activate).toHaveBeenCalledWith(parent.tab.id, paneKey)
    expect(requests.map((r) => r.agentId)).toEqual(['W'])
    await act(async () => {
      expect(takeAndSettle('no agent under that id').agentId).toBe('W')
    })
    expect(requests.map((r) => r.agentId)).toEqual(['W', undefined])
    expect(requests[0]).toMatchObject({
      terminal: 'T',
      sessionId: 'P',
      client: { id: 'orca-desktop', type: 'desktop' }
    })
    expect(requests[1]).toEqual({ ...requests[0], agentId: undefined })
    expect(requests[1]).not.toHaveProperty('agentId')
    expect(mocks.info).not.toHaveBeenCalled()
    await act(async () => {
      expect(takeAndSettle().agentId).toBeUndefined()
    })
    // An ACK settles delivery, not the provider's current conversation.
    expect(element(1).getAttribute('aria-current')).toBe('true')
    expect(element(0).hasAttribute('aria-current')).toBe(false)
    await act(async () => {
      observe()
    })
    expect(element(0).getAttribute('aria-current')).toBe('true')
    expect(element(1).hasAttribute('aria-current')).toBe(false)
    expect(element(2).hasAttribute('aria-current')).toBe(false)
    expect(bridge.receive({ ...identity(), action: 'take' })).toEqual({})
    expect(requests).toHaveLength(2)
    expect(mocks.info).not.toHaveBeenCalled()
  }
)

it.each(['compact', 'full'] as const)(
  'labels %s workflow action and preserves ordinary success and parent-already-current',
  async (layout) => {
    const workflow = child('modern', 'workflow-subagent')
    rows(layout, workflow)
    expect(element(2).getAttribute('aria-description')).toBe('Open parent conversation')
    await click(2)
    expect(requests.map((r) => r.agentId)).toEqual([undefined])
    await act(async () => {
      takeAndSettle()
      observe()
    })
    await click(2)
    expect(requests.map((r) => r.agentId)).toEqual([undefined, undefined])
    expect(bridge.receive({ ...identity(), action: 'take' })).toEqual({})
    await click(1)
    expect(requests.at(-1)?.agentId).toBe('A')
    await act(async () => {
      takeAndSettle()
      observe('A', paneKey, 3)
    })
    expect(element(1).getAttribute('aria-current')).toBe('true')
    expect(element(2).hasAttribute('aria-current')).toBe(false)
    expect(mocks.info).not.toHaveBeenCalled()
  }
)

it.each(['terminal', 'session', 'child-id', 'owner'] as const)(
  'reports missing %s without dispatching a wrong target',
  async (missing) => {
    let row = child('restored')
    if (missing === 'terminal') {
      missingTerminal = true
    }
    if (missing === 'session') {
      useAppStore.setState({
        agentStatusByPaneKey: { [paneKey]: { ...parent.entry, providerSession: undefined } }
      })
    }
    if (missing === 'child-id') {
      row = {
        ...row,
        childRow: row.childRow ? { ...row.childRow, providerId: undefined, id: '' } : undefined
      }
    }
    if (missing === 'owner') {
      mocks.owner.mockReturnValue({ kind: 'ambiguous' })
    }
    await viewClaudeAgentFromRow(row)
    expect(requests).toHaveLength(0)
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
      'Claude could not open this agent. Try again in the Claude pane.'
    )
  }
)

it.each(['child', 'parent'] as const)(
  'ignores a settled denial held in transport after a newer %s success',
  async (newer) => {
    const gate = deferred()
    delayedResponse = { agentId: 'W', gate }
    const old = viewClaudeAgentFromRow(child('restored'))
    await act(async () => {})
    takeAndSettle('no agent under that id')
    const next = viewClaudeAgentFromRow(
      newer === 'parent' ? parent : child('legacy', 'general-purpose', 'B')
    )
    await act(async () => {})
    takeAndSettle()
    observe(newer === 'parent' ? undefined : 'B')
    await next
    gate.resolve()
    await old
    expect(requests.map((r) => r.agentId)).toEqual(['W', newer === 'parent' ? undefined : 'B'])
    expect(mocks.info).not.toHaveBeenCalled()
  }
)

it.each(['owner', 'session', 'pane', 'binding', 'revision'] as const)(
  'does not recover or report stale %s targets',
  async (replacement) => {
    owner = { endpoint: { kind: 'environment', environmentId: 'remote' }, at: 'local' }
    mocks.owner.mockImplementation(() => ({ kind: 'resolved', owner }))
    const action = viewClaudeAgentFromRow(child('restored'))
    await act(async () => {})
    if (replacement === 'owner') {
      owner = { endpoint: { kind: 'self' }, at: 'ssh:replacement' }
    }
    if (replacement === 'session') {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [paneKey]: { ...parent.entry, providerSession: { key: 'session_id', id: 'replacement' } }
        }
      })
    }
    if (replacement === 'pane') {
      useAppStore.setState({ agentStatusByPaneKey: {} })
    }
    if (replacement === 'binding') {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          [parent.tab.id]: {
            root: null,
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: 'replacement' }
          }
        }
      })
    }
    if (replacement === 'revision') {
      replaceRuntimeEnvironmentRevisions([{ id: 'remote', createdAt: 1, pairingRevision: 2 }])
    }
    takeAndSettle('no agent under that id')
    await action
    expect(requests.map((r) => r.agentId)).toEqual(['W'])
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(mocks.info).not.toHaveBeenCalled()
  }
)

it.each(['list', 'compatibility'] as const)(
  'fences delayed first %s resolution before dispatch and releases its intent',
  async (phase) => {
    const gate = deferred()
    if (phase === 'list') {
      delayList = gate
    } else {
      owner = { endpoint: { kind: 'environment', environmentId: 'remote' }, at: 'local' }
      mocks.owner.mockImplementation(() => ({ kind: 'resolved', owner }))
      delayStatus = gate
      const { clearRuntimeCompatibilityCache } =
        await import('@/runtime/rpc/compatibility/runtime-compatibility-cache')
      clearRuntimeCompatibilityCache()
    }
    const old = viewClaudeAgentFromRow(child('restored'))
    delayList = undefined
    delayStatus = undefined
    forced = { status: 'viewed' }
    const next = viewClaudeAgentFromRow(parent)
    gate.resolve()
    await Promise.all([old, next])
    expect(requests.map((r) => r.agentId)).toEqual([undefined])
    expect(mocks.info).not.toHaveBeenCalled()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  }
)

it('does not block an independent pane while another action awaits denial', async () => {
  const secondKey = makePaneKey('second-tab', leafId)
  const second: DashboardAgentRow = {
    ...parent,
    paneKey: secondKey,
    tab: { ...parent.tab, id: 'second-tab' },
    entry: { ...parent.entry, paneKey: secondKey }
  }
  useAppStore.setState({
    agentStatusByPaneKey: { [paneKey]: parent.entry, [secondKey]: second.entry }
  })
  bridge.receive({
    ...identity(secondKey),
    action: 'register',
    keybindings,
    view: { agentId: 'A', revision: 1 }
  })
  const first = viewClaudeAgentFromRow(child('restored'))
  const other = viewClaudeAgentFromRow(second)
  await act(async () => {})
  takeAndSettle(undefined, secondKey)
  await other
  expect(requests).toHaveLength(2)
  takeAndSettle('no agent under that id')
  await act(async () => {})
  expect(requests.at(-1)).toMatchObject({ terminal: 'T', sessionId: 'P' })
  expect(requests.at(-1)?.agentId).toBeUndefined()
  takeAndSettle()
  await first
  expect(requests).toHaveLength(3)
  expect(mocks.info).not.toHaveBeenCalled()
})
