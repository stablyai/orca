// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  activatePane: vi.fn(),
  activateChat: vi.fn(async () => true),
  paneUnavailable: vi.fn(),
  toastInfo: vi.fn(),
  focusRenderer: vi.fn(() => true),
  focusRuntime: vi.fn(async () => undefined)
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focusRenderer,
  focusRuntimeTerminalHandle: mocks.focusRuntime
}))
vi.mock('sonner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  toast: { info: mocks.toastInfo, error: vi.fn() }
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/components/sidebar/use-worktree-agent-activation', () => ({
  activateWorktreeAgentPane: mocks.activatePane
}))
vi.mock('@/components/terminal-pane/stale-agent-row', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  showAgentPaneUnavailable: mocks.paneUnavailable
}))
vi.mock('@/lib/activate-ai-vault-structured-session', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  activateAiVaultStructuredSession: mocks.activateChat
}))

import { useAppStore } from '@/store'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import {
  agentMessageSenderOpens,
  agentMessageSenderReplacedOnHandle,
  agentMessageSenderUnavailableText,
  GONE_TERMINAL_SENDER_CLICK,
  resolveAgentMessageSenderTarget
} from './native-chat-agent-message-sender-target'
import { unnamedSenderLabel } from './native-chat-agent-message-sender-label'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { sameAgentIdentity } from '../../../../shared/agent-title-owner'
import { initialStore, resetSenderStore, status } from './native-chat-agent-sender.test-fixture'
import type { AgentSenderPublication } from '../../../../shared/agent-sender-associations'
import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../../../shared/agent-session/agent-session-message-source'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

const LOCAL = { kind: 'local' } as const
let revision = 0
/** Each delivery is the host's next revision, as a publishing host stamps it. */
const publication = (
  associations: AgentSenderPublication['associations'] = []
): AgentSenderPublication => ({
  associations,
  principals: [],
  attachments: [],
  revision: { epoch: 'host', revision: ++revision }
})
const terminal = (handle = 'term_0', agent: AgentMessageSender['agent'] = 'claude') => ({
  party: { address: handle, terminalHandle: handle, orcaSessionId: null },
  name: 'Worker',
  agent
})
const sourceOf = (sender: AgentMessageSender): AgentMessageSource => ({
  kind: 'agent',
  senders: [sender],
  orchestration: null
})
const open = (sender: AgentMessageSender, dispatchId?: string) =>
  openAgentMessageSender(sourceOf(sender), sender, 'workspace', LOCAL, dispatchId, 'Worker')
/** What the card draws for this sender: its avatar, and whether its name is a link. */
const card = (sender: AgentMessageSender, dispatchId?: string) => ({
  avatar: renderHook(() => useAgentMessageSenderView(sender, 'workspace', LOCAL, dispatchId)).result
    .current,
  link: agentMessageSenderOpens(
    resolveAgentMessageSenderTarget(useAppStore.getState(), sender, 'workspace', LOCAL, dispatchId),
    sender
  )
})
const row = (identity: string, i: number) => ({
  identity,
  paneKey: status(i).paneKey,
  worktreeId: 'workspace'
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  resetSenderStore()
  for (const mock of Object.values(mocks)) {
    mock.mockClear()
  }
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
})

it('opens the very pane a reopened worker runs in, through the sidebar path', async () => {
  const paneKey = status(1).paneKey
  useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: status(1) } })
  useAppStore.getState().setAgentSenderPublication('local', publication([row('dispatch:first', 1)]))
  const sender = terminal('term_before')
  expect(card(sender, 'first')).toEqual({
    avatar: expect.objectContaining({ dot: 'working' }),
    link: true
  })
  await open(sender, 'first')
  expect(mocks.activatePane).toHaveBeenCalledWith('workspace', 'tab-1', paneKey)
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
})

it('opens a hooks-off or plain-shell sender by its live handle though no status row names it', async () => {
  useAppStore.setState({ agentStatusByPaneKey: {} })
  useAppStore.getState().setAgentSenderPublication('local', publication([row('term_0', 0)]))
  expect(card(terminal())).toEqual({ avatar: { agentType: 'claude' }, link: true })
  await open(terminal())
  expect(mocks.activatePane).toHaveBeenCalledWith('workspace', 'tab-0', status(0).paneKey)
})

it('draws a Claude card whose terminal now runs Codex as a plain name, with no dot', async () => {
  useAppStore.setState({
    agentStatusByPaneKey: { [status(0).paneKey]: { ...status(0), agentType: 'codex' } }
  })
  useAppStore.getState().setAgentSenderPublication('local', publication([row('term_0', 0)]))
  expect(card(terminal())).toEqual({ avatar: { agentType: 'claude' }, link: false })
  // A click that raced the change says so by name, and opens nothing.
  await open(terminal())
  expect(mocks.toastInfo).toHaveBeenCalledWith(expect.stringContaining('Worker'))
  expect(mocks.activatePane).not.toHaveBeenCalled()
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  expect(mocks.paneUnavailable).not.toHaveBeenCalled()
})

it('draws a sender two rows claim as a plain name and never falls through to another pane', async () => {
  useAppStore
    .getState()
    .setAgentSenderPublication('local', publication([row('term_0', 0), row('term_0', 1)]))
  expect(card(terminal())).toEqual({ avatar: { agentType: 'claude' }, link: false })
  await open(terminal())
  expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
  expect(mocks.activatePane).not.toHaveBeenCalled()
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
})

it('asks the host, with no dot, for a terminal sender whose terminal exited or was respawned', async () => {
  expect(GONE_TERMINAL_SENDER_CLICK).toBe('host-lookup')
  // The pane still shows a row, but the host no longer publishes the card's handle.
  useAppStore.getState().setAgentSenderPublication('local', publication())
  expect(card(terminal())).toEqual({ avatar: { agentType: 'claude' }, link: true })
  mocks.callRuntimeRpc.mockResolvedValue({ location: null, lost: 'terminal' })
  await open(terminal())
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL, 'orchestration.partyLocation', {
    address: 'term_0'
  })
})

it('reopens a closed chat sender through the host lineage lookup', async () => {
  useAppStore.getState().setAgentSenderPublication('local', publication())
  const session = testOrcaSessionId('55555555-5555-4555-8555-555555555555')
  const chat: AgentMessageSender = {
    party: { address: `orca_session_id:${session}`, terminalHandle: null, orcaSessionId: session },
    name: 'Closed chat'
  }
  expect(card(chat).link).toBe(true)
  mocks.callRuntimeRpc.mockResolvedValue({
    location: { kind: 'chat', sessionId: session, worktreeId: 'workspace' }
  })
  await open(chat)
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL, 'orchestration.partyLocation', {
    address: chat.party.address
  })
  expect(mocks.activateChat).toHaveBeenCalledTimes(1)
})

it('keeps an older host on its own lookup', async () => {
  mocks.callRuntimeRpc.mockResolvedValue({ location: null, lost: 'terminal' })
  await open(terminal('term_old'))
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL, 'orchestration.partyLocation', {
    address: 'term_old'
  })
})

describe('an older paired host, which publishes no sender locations', () => {
  const OLD = { kind: 'environment', environmentId: 'old-host' } as const
  const oldCard = (sender: AgentMessageSender) => ({
    avatar: renderHook(() => useAgentMessageSenderView(sender, 'workspace', OLD)).result.current,
    link: agentMessageSenderOpens(
      resolveAgentMessageSenderTarget(useAppStore.getState(), sender, 'workspace', OLD, undefined),
      sender
    )
  })
  const openOld = (sender: AgentMessageSender) =>
    openAgentMessageSender(sourceOf(sender), sender, 'workspace', OLD, undefined, 'Worker')
  const live = (agentType: string, handle = 'term_0') =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        [status(0).paneKey]: { ...status(0), terminalHandle: handle, agentType }
      }
    })
  beforeEach(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:old-host' }))

  it('draws a Claude card whose terminal now runs Codex as a plain name, and opens nothing', async () => {
    live('codex')
    expect(oldCard(terminal())).toEqual({ avatar: { agentType: 'claude' }, link: false })
    await openOld(terminal())
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Worker is no longer running in its terminal; another agent is running there now. Open that terminal from the sidebar if you need it.'
    )
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['omp', 'pi'],
    ['claude-agent-teams', 'claude'],
    [undefined, 'codex']
  ] as const)('keeps a %s card over a %s terminal live and opening', async (saved, running) => {
    live(running)
    const { agent: _claude, ...unsaved } = terminal()
    const sender = saved ? terminal('term_0', saved) : unsaved
    expect(oldCard(sender)).toEqual({
      avatar: expect.objectContaining({ dot: 'working' }),
      link: true
    })
    mocks.callRuntimeRpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_0' } })
    await openOld(sender)
    expect(mocks.focusRenderer).toHaveBeenCalledWith('term_0', 'old-host')
  })

  it('still asks the host when no row names the terminal, and judges what it returns by the same rule', async () => {
    useAppStore.setState({ agentStatusByPaneKey: {} })
    expect(oldCard(terminal()).link).toBe(true)
    // The host recovers a newer handle whose terminal runs Codex: not the Claude sender.
    live('codex', 'term_recovered')
    mocks.callRuntimeRpc.mockResolvedValueOnce({
      location: { kind: 'terminal', handle: 'term_recovered' }
    })
    await openOld(terminal('term_gone'))
    expect(mocks.focusRenderer).not.toHaveBeenCalled()
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1)
    // A host before the lookup falls back to the card's own handle, under the same rule.
    live('codex', 'term_gone')
    useAppStore.setState({ agentStatusByPaneKey: {} })
    mocks.callRuntimeRpc.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'rpc',
        ok: false,
        error: { code: 'method_not_found', message: 'method_not_found' },
        _meta: { runtimeId: 'old' }
      })
    )
    await openOld(terminal('term_gone'))
    expect(mocks.focusRenderer).toHaveBeenCalledWith('term_gone', 'old-host')
  })
})

it('names the agent and what to do in every message a raced click shows', () => {
  const unnamed = unnamedSenderLabel()
  expect(agentMessageSenderUnavailableText({ kind: 'replaced' }, unnamed)).toBe(
    'An agent is no longer running in its terminal; another agent is running there now. Open that terminal from the sidebar if you need it.'
  )
  expect(agentMessageSenderUnavailableText({ kind: 'ambiguous' }, 'Worker')).toBe(
    "Orca can't tell which terminal Worker is running in. Open it from the sidebar."
  )
  expect(agentMessageSenderUnavailableText({ kind: 'gone', sender: 'other' }, unnamed)).toBe(
    'An agent is no longer running. Start a new agent from the sidebar to continue its work.'
  )
})

it.each([
  ['omp', 'pi', true],
  ['claude-agent-teams', 'claude', true],
  ['claude', 'claude', true],
  ['claude', 'codex', false]
] as const)('treats %s and %s as one agent: %s, in both directions', (a, b, same) => {
  expect([sameAgentIdentity(a, b), sameAgentIdentity(b, a)]).toEqual([same, same])
})

it('reads a saved "unknown" kind as no kind: the live row draws, and nothing vetoes it', async () => {
  const sender = terminal('term_0', 'unknown')
  // Older host: no publication, so the window's own lookup places the terminal.
  expect(card(sender)).toEqual({
    avatar: expect.objectContaining({ agentType: 'claude', dot: 'working' }),
    link: true
  })
  expect(
    agentMessageSenderReplacedOnHandle(useAppStore.getState(), sender, 'local', 'term_0')
  ).toBe(false)
  useAppStore.getState().setAgentSenderPublication('local', publication([row('term_0', 0)]))
  expect(card(sender)).toEqual({
    avatar: expect.objectContaining({ agentType: 'claude', dot: 'working' }),
    link: true
  })
  await open(sender)
  expect(mocks.activatePane).toHaveBeenCalledWith('workspace', 'tab-0', status(0).paneKey)
  expect(mocks.toastInfo).not.toHaveBeenCalled()
})

it('keeps a published OMP card over its Pi-launched terminal live and opening', async () => {
  useAppStore.setState({
    agentStatusByPaneKey: { [status(0).paneKey]: { ...status(0), agentType: 'pi' } }
  })
  useAppStore.getState().setAgentSenderPublication('local', publication([row('term_0', 0)]))
  expect(card(terminal('term_0', 'omp'))).toEqual({
    avatar: expect.objectContaining({ agentType: 'omp', dot: 'working' }),
    link: true
  })
  await open(terminal('term_0', 'omp'))
  expect(mocks.activatePane).toHaveBeenCalledWith('workspace', 'tab-0', status(0).paneKey)
})
