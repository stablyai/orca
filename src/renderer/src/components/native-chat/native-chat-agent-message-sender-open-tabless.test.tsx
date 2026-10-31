// @vitest-environment happy-dom
// The sidebar activation runs for real here: a located sender this window shows no tab for must
// still open, through the host lookup that reveals it.
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async (_target: unknown, method: string) =>
    method === 'orchestration.partyLocation'
      ? { location: { kind: 'terminal', handle: 'term_1' } }
      : undefined
  ),
  focusRenderer: vi.fn(() => false),
  focusRuntime: vi.fn(async () => undefined)
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focusRenderer,
  focusRuntimeTerminalHandle: mocks.focusRuntime
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))

import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'
import {
  agentMessageSenderOpens,
  resolveAgentMessageSenderTarget
} from './native-chat-agent-message-sender-target'
import { initialStore, resetSenderStore, status } from './native-chat-agent-sender.test-fixture'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'

const LOCAL = { kind: 'local' } as const
const sender: AgentMessageSender = {
  party: { address: 'term_before', terminalHandle: 'term_before', orcaSessionId: null },
  name: 'Worker',
  agent: 'claude'
}
const open = () =>
  openAgentMessageSender(
    { kind: 'agent', senders: [sender], orchestration: null },
    sender,
    'workspace',
    LOCAL,
    'first',
    'Worker'
  )

beforeEach(() => {
  resetSenderStore()
  const paneKey = status(1).paneKey
  // The host runs the worker in tab-1, which this window hasn't loaded; its status arrived first.
  useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: status(1) } })
  useAppStore.getState().setAgentSenderPublication('local', {
    associations: [{ identity: 'dispatch:first', paneKey, worktreeId: 'workspace' }],
    principals: [],
    attachments: [],
    revision: { epoch: 'host', revision: 1 }
  })
  for (const mock of Object.values(mocks)) {
    mock.mockClear()
  }
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
})

it('asks the host to reveal a located worker whose tab this window has not loaded', async () => {
  const resolved = resolveAgentMessageSenderTarget(
    useAppStore.getState(),
    sender,
    'workspace',
    LOCAL,
    'first'
  )
  expect(resolved.kind).toBe('located')
  expect(agentMessageSenderOpens(resolved, sender)).toBe(true)
  await open()
  expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL, 'orchestration.partyLocation', {
    address: 'term_before'
  })
  expect(mocks.focusRuntime).toHaveBeenCalledWith('term_1', null)
})

it('opens the tab itself, without asking the host, once this window holds it', async () => {
  useAppStore.setState({
    tabsByWorktree: {
      workspace: [
        makeTab({ id: 'tab-0', worktreeId: 'workspace' }),
        makeTab({ id: 'tab-1', worktreeId: 'workspace' })
      ]
    }
  })
  await open()
  expect(useAppStore.getState().activeTabId).toBe('tab-1')
  expect(mocks.callRuntimeRpc).not.toHaveBeenCalledWith(
    LOCAL,
    'orchestration.partyLocation',
    expect.anything()
  )
})
