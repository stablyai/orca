// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  activatePane: vi.fn(),
  activateChat: vi.fn(async () => true),
  paneUnavailable: vi.fn(),
  toastInfo: vi.fn()
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
  GONE_TERMINAL_SENDER_CLICK,
  resolveAgentMessageSenderTarget
} from './native-chat-agent-message-sender-target'
import { initialStore, resetSenderStore, status } from './native-chat-agent-sender.test-fixture'
import type { AgentSenderPublication } from '../../../../shared/agent-sender-associations'
import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../../../shared/agent-session/agent-session-message-source'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

const LOCAL = { kind: 'local' } as const
const publication = (
  associations: AgentSenderPublication['associations'] = []
): AgentSenderPublication => ({ associations, principals: [], attachments: [] })
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
