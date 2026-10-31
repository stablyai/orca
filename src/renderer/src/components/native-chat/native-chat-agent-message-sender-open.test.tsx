// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  activatePane: vi.fn(),
  activateChat: vi.fn(async () => true),
  paneUnavailable: vi.fn()
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
import { UNPROVED_SENDER_CLICK } from '@/runtime/agent-sender-associations'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
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
const terminal = (identity?: string): AgentMessageSender => ({
  party: { address: 'term_old', terminalHandle: 'term_old', orcaSessionId: null },
  name: 'Worker',
  agent: 'claude',
  ...(identity ? { identity } : {})
})
const sourceOf = (sender: AgentMessageSender): AgentMessageSource => ({
  kind: 'agent',
  senders: [sender],
  orchestration: null
})
const open = (sender: AgentMessageSender, dispatchId?: string) =>
  openAgentMessageSender(sourceOf(sender), sender, 'workspace', LOCAL, dispatchId)

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

it('opens the very pane the avatar located for a reopened worker, through the sidebar path', async () => {
  const paneKey = status(1).paneKey
  useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: status(1) } })
  useAppStore
    .getState()
    .setAgentSenderPublication(
      'local',
      publication([{ identity: 'dispatch:first', paneKey, worktreeId: 'workspace' }])
    )
  const sender = terminal()
  const avatar = renderHook(() => useAgentMessageSenderView(sender, 'workspace', LOCAL, 'first'))
  expect(avatar.result.current.dot).toBe('working')
  await open(sender, 'first')
  expect(mocks.activatePane).toHaveBeenCalledWith('workspace', 'tab-1', paneKey)
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
})

it('opens nothing when two rows claim the sender, and never falls back to the old pane', async () => {
  useAppStore.getState().setAgentSenderPublication(
    'local',
    publication([
      { identity: 'conversation:c', paneKey: status(0).paneKey, worktreeId: 'workspace' },
      { identity: 'conversation:c', paneKey: status(1).paneKey, worktreeId: 'workspace' }
    ])
  )
  const sender = terminal('conversation:c')
  expect(
    renderHook(() => useAgentMessageSenderView(sender, 'workspace', LOCAL)).result.current
  ).toEqual({ agentType: 'claude' })
  await open(sender)
  expect(mocks.paneUnavailable).toHaveBeenCalledTimes(1)
  expect(mocks.activatePane).not.toHaveBeenCalled()
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
})

it('reopens a closed chat sender through the host lineage lookup', async () => {
  useAppStore.getState().setAgentSenderPublication('local', publication())
  const session = testOrcaSessionId('55555555-5555-4555-8555-555555555555')
  const chat: AgentMessageSender = {
    party: { address: `orca_session_id:${session}`, terminalHandle: null, orcaSessionId: session },
    name: 'Closed chat'
  }
  mocks.callRuntimeRpc.mockResolvedValue({
    location: { kind: 'chat', sessionId: session, worktreeId: 'workspace' }
  })
  await open(chat)
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL, 'orchestration.partyLocation', {
    address: chat.party.address
  })
  expect(mocks.activateChat).toHaveBeenCalledTimes(1)
})

it('says an unproved old terminal sender is no longer available instead of asking the old lookup', async () => {
  expect(UNPROVED_SENDER_CLICK).toBe('unavailable')
  useAppStore
    .getState()
    .setAgentSenderPublication(
      'local',
      publication([
        { identity: 'conversation:new', paneKey: status(0).paneKey, worktreeId: 'workspace' }
      ])
    )
  // A terminal that is live under the old handle is no proof it still runs the sender.
  useAppStore.setState({ agentStatusByPaneKey: { [status(0).paneKey]: status(0) } })
  const sender = terminal()
  expect(
    renderHook(() => useAgentMessageSenderView(sender, 'workspace', LOCAL)).result.current
  ).toEqual({ agentType: 'claude' })
  await open(sender)
  expect(mocks.paneUnavailable).toHaveBeenCalledTimes(1)
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
})

it('keeps an older host on its own lookup', async () => {
  mocks.callRuntimeRpc.mockResolvedValue({ location: null, lost: 'terminal' })
  await open(terminal())
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL, 'orchestration.partyLocation', {
    address: 'term_old'
  })
})
