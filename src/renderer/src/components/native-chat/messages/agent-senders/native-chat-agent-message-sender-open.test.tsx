// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  activatePane: vi.fn(),
  activateChat: vi.fn(async () => true),
  paneUnavailable: vi.fn(),
  toastInfo: vi.fn(),
  focusRenderer: vi.fn(() => true),
  focusRuntime: vi.fn(async () => undefined)
}))
vi.mock('@/components/terminal-pane/links/handles/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focusRenderer,
  focusRuntimeTerminalHandle: mocks.focusRuntime
}))
vi.mock('sonner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  toast: { info: mocks.toastInfo, error: vi.fn() }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-agent-activation', () => ({
  activateWorktreeAgentPane: mocks.activatePane
}))
vi.mock('@/components/terminal-pane/agent-status/stale-agent-row', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  showAgentPaneUnavailable: mocks.paneUnavailable
}))
vi.mock('@/lib/activate-ai-vault-structured-session', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  activateAiVaultStructuredSession: mocks.activateChat
}))
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  activateStructuredAgentSessionById: mocks.activateChat
}))

import { useAppStore } from '@/store'

import { openAgentMessageSender } from '@/lib/open-agent-message-sender'

import {
  agentMessageSenderOpens,
  resolveAgentMessageSenderTarget
} from './native-chat-agent-message-sender-target'

import { initialStore, resetSenderStore, status } from './native-chat-agent-sender.test-fixture'
import type { AgentSenderPublication } from '../../../../../../shared/agent-sender-associations'
import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../../../../../shared/agent-session/agent-session-message-source'

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { handleGlobalSessionEvent } from '@/runtime/web-session-tabs-sync/global-session-events'
import { receivedAgentSenderPublications } from '@/runtime/web-session-tabs-sync/received-agent-sender-publications'
import { VisibilityResumeCoordinator } from '@/runtime/web-session-tabs-sync/visibility-resume-coordinator'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'

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

/** What the card draws for this sender: its avatar, and whether its name is a link. */

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

it("asks a paired host for its floating terminal's sender, which this window never mirrors", async () => {
  resetWebSessionTabsSnapshotFreshnessForTests()
  const paired = { kind: 'environment', environmentId: 'paired' } as const
  const frame = (worktree: string, revision: number, identity: string) => {
    const scope = publication([{ identity, paneKey: status(0).paneKey, worktreeId: worktree }])
    return {
      type: 'updated',
      worktree,
      publicationEpoch: 'host',
      snapshotVersion: revision,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [],
      agentSenderAssociations: { ...scope, revision: { epoch: 'paired-host', revision } }
    }
  }
  // The window's real stream receipt, as for any paired frame.
  const receive = (event: ReturnType<typeof frame>) =>
    act(() =>
      handleGlobalSessionEvent({
        environmentId: 'paired',
        expectedEnvironmentConnectionGeneration: 0,
        expectedTrackingGeneration: 0,
        visibilityGeneration: 0,
        isCurrent: () => true,
        event,
        response: { id: 'stream', ok: true, result: event, _meta: { runtimeId: 'rt-1' } },
        awaitingVisibilityResumeInventory: { value: false },
        coordinator: new VisibilityResumeCoordinator({
          environments: [],
          environmentIdBySubscriptionSpec: [],
          omissions: new Map(),
          activeRuntimeWorktreeKey: () => null
        })
      })
    )
  const floatingTabs = useAppStore.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  receive(frame(FLOATING_TERMINAL_WORKTREE_ID, 1, 'term_float'))
  receive(frame('workspace', 2, 'term_0'))
  const state = useAppStore.getState()
  expect(Object.keys(state.agentSenderPublicationsByHost['runtime:paired'])).toEqual(['workspace'])
  expect(state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(floatingTabs)
  const floating = terminal('term_float')
  const resolved = resolveAgentMessageSenderTarget(state, floating, 'workspace', paired, undefined)
  expect(resolved).toEqual({ kind: 'gone', sender: 'terminal' })
  expect(agentMessageSenderOpens(resolved, floating)).toBe(true)
  await openAgentMessageSender(
    sourceOf(floating),
    floating,
    'workspace',
    paired,
    undefined,
    'Worker'
  )
  expect(mocks.callRuntimeRpc).toHaveBeenCalled()
  expect(mocks.activatePane).not.toHaveBeenCalled()
  // This machine's own floating terminal still publishes its senders.
  const local = receivedAgentSenderPublications({}, 'local', [
    frame(FLOATING_TERMINAL_WORKTREE_ID, 3, 'term_local')
  ])
  expect(Object.keys(local.local)).toEqual([FLOATING_TERMINAL_WORKTREE_ID])
})
