// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { useNativeChatTerminalPromptCard } from './use-native-chat-interactive-prompt-card'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { agentStatusByPaneKey: Record<string, never> }) => unknown) =>
    selector({ agentStatusByPaneKey: {} })
}))
const send: NativeChatInteractiveSend = {
  sendAnswer: vi.fn(),
  sendRaw: vi.fn(),
  sendRawVerified: vi.fn(),
  cancelPending: vi.fn(),
  cancel: vi.fn(),
  cancelAsk: vi.fn()
}
function Card({ messages }: { messages: NativeChatMessage[] }) {
  const { presentation, actionKey } = useNativeChatTerminalPromptCard({
    paneKey: 'blocking-notice:leaf',
    targetPtyId: 'pty',
    runtimeEnvironmentId: null,
    agent: 'claude',
    sessionId: 'session',
    transcriptPath: null,
    messages,
    transcriptSettled: true,
    canSend: true
  })
  return (
    <TooltipProvider>
      {presentation.card && (
        <NativeChatInteractiveCard
          key={actionKey}
          card={presentation.card}
          send={send}
          onDismiss={presentation.dismiss}
        />
      )}
    </TooltipProvider>
  )
}
afterEach(cleanup)

it('retains selected and typed blocking answers across a projected notice until its result', () => {
  // Mixed-source contract fixture: Claude-shaped transcript plus journal projection; no live delivery claim.
  const asked: NativeChatMessage = {
    id: 'ask',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: {
          questions: [
            { question: 'Tabs or spaces?', options: [{ label: 'Tabs' }, { label: 'Spaces' }] }
          ]
        }
      }
    ]
  }
  const notice = projectStructuredItemToNativeChat({
    itemId: 'notice',
    sequence: 2,
    revision: 1,
    observedAt: 2,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Agent update' }],
      from: { kind: 'agent', senders: [], orchestration: null }
    }
  })!
  const view = render(<Card messages={[asked]} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Four spaces' } })
  fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
  view.rerender(<Card messages={[asked, notice]} />)
  expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Spaces/ })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('textbox')).toHaveValue('Four spaces')
  view.rerender(
    <Card
      messages={[
        asked,
        notice,
        {
          id: 'result',
          role: 'tool',
          timestamp: 3,
          source: 'transcript',
          blocks: [{ type: 'tool-result', output: 'Spaces' }]
        }
      ]}
    />
  )
  expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  expect(send.sendAnswer).not.toHaveBeenCalled()
})
