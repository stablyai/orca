// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import { initialStore, resetSenderStore, status } from './native-chat-agent-sender.test-fixture'
import {
  resolveAgentMessageSenderTarget,
  agentMessageSenderOpens
} from './native-chat-agent-message-sender-target'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import { receivedAgentSenderPublications } from '@/runtime/web-session-tabs-sync/received-agent-sender-publications'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { RuntimeAgentSenderPublicationTestModule } from '../../../../shared/runtime-agent-sender-consumer.test-fixture'

const {
  default: { verifyHeldSenderPublication }
} = await vi.importActual<{ default: RuntimeAgentSenderPublicationTestModule }>(
  '../../../../main/runtime/runtime-agent-sender-publication.test-fixture'
)
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
})

it('preserves structural publication across held sender discovery', async () => {
  resetSenderStore()
  const paneKey = 'sender-tab:11111111-1111-4111-8111-111111111111'
  useAppStore.setState({
    tabsByWorktree: { 'workspace-1': [makeTab({ id: 'sender-tab', worktreeId: 'workspace-1' })] },
    agentStatusByPaneKey: {
      [paneKey]: {
        ...status(0, 'workspace-1'),
        paneKey,
        terminalHandle: 'term_sender',
        agentType: 'codex'
      }
    }
  })
  const sender: AgentMessageSender = {
    party: { address: 'term_sender', terminalHandle: 'term_sender', orcaSessionId: null },
    name: 'Original agent',
    agent: 'claude'
  }
  await verifyHeldSenderPublication((phase, frame) => {
    useAppStore.setState({
      agentSenderPublicationsByHost: receivedAgentSenderPublications(
        useAppStore.getState().agentSenderPublicationsByHost,
        'local',
        [frame]
      )
    })
    if (phase === 'successor') {
      expect(useAppStore.getState().agentSenderPublicationsByHost?.local?.['workspace-2']).toBe(
        frame.agentSenderAssociations
      )
      return
    }
    const target = resolveAgentMessageSenderTarget(
      useAppStore.getState(),
      sender,
      'workspace-1',
      { kind: 'local' },
      undefined
    )
    expect(target).toEqual({ kind: 'gone', sender: 'terminal' })
    expect(agentMessageSenderOpens(target, sender)).toBe(true)
    const avatar = renderHook(() =>
      useAgentMessageSenderView(sender, 'workspace-1', { kind: 'local' })
    )
    expect(avatar.result.current).toEqual({ agentType: 'claude' })
  })
})
