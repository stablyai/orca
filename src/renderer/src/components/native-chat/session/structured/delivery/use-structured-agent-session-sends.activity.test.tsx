// @vitest-environment happy-dom
import { Activity, StrictMode } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPaneLifetime } from '../../../pane/ownership/native-chat-pane-lifetime'
import { projectStructuredAgentSessionMessages } from '../../../conversation/projection/structured-agent-session-message-projection'
import {
  deferredCalls,
  flush,
  mocks,
  okSubmission,
  send,
  SESSION,
  target
} from './structured-agent-session-message-sender.test-fixture'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'

vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))

function Transcript() {
  const { pending } = useStructuredAgentSessionSends({
    sessionId: SESSION,
    target,
    fence: 4,
    submissions: [],
    queuedMessageIds: [],
    queue: {
      capability: 'supported',
      followUpsQueue: false,
      isWorking: false,
      stopping: false,
      session: {},
      prompts: []
    },
    historyLoaded: false
  })
  return projectStructuredAgentSessionMessages([], pending, []).map((message) => (
    <p key={message.id}>
      {message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')}
    </p>
  ))
}

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
  mocks.call.mockReset()
})

it('keeps the sent message on return when its acknowledgement arrives while the chat is hidden', async () => {
  const pane = (visible: boolean) => (
    <StrictMode>
      <NativeChatPaneLifetime isVisible={visible}>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <Transcript />
        </Activity>
      </NativeChatPaneLifetime>
    </StrictMode>
  )
  const view = render(pane(true))
  const calls = deferredCalls()
  const sent = await act(async () => {
    const sent = send('Keep this message on return')
    await flush()
    return sent
  })
  await waitFor(() => expect(calls[0]).toBeDefined())
  expect(view.getByText('Keep this message on return')).toBeTruthy()
  view.rerender(pane(false))
  await act(async () => {
    calls[0].resolve(okSubmission(sent.clientMessageId, 'accepted'))
    await sent.outcome
  })
  view.rerender(pane(true))
  expect(view.getByText('Keep this message on return')).toBeTruthy()
  view.unmount()
  await act(async () => {})
})
