// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatAsyncQuestionContext } from './native-chat-async-question-context'

vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: () => {
    throw new Error('Unexpected inline visual')
  }
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: () => {
    throw new Error('Unexpected sender navigation')
  }
}))

const send = vi.fn(() => true)
const reply = { disabled: false, send }

afterEach(() => {
  cleanup()
  send.mockClear()
})

const message: NativeChatMessage = {
  id: 'question-1',
  role: 'assistant',
  source: 'transcript',
  timestamp: 1,
  blocks: [
    { type: 'text', text: 'I can keep working.' },
    {
      type: 'text',
      text: 'Which branch?\n1. main\n2. release',
      asyncQuestions: [{ title: 'Which branch?', options: ['main', 'release'] }]
    }
  ]
}

it.each([true, false])('offers the question once while working=%s', (working) => {
  render(
    <TooltipProvider>
      <NativeChatAsyncQuestionContext.Provider value={reply}>
        <MessageRow
          message={message}
          expandSignal={false}
          activeTurnIsWorking={working}
          onScrollMessageToTop={vi.fn()}
        />
      </NativeChatAsyncQuestionContext.Provider>
    </TooltipProvider>
  )
  expect(screen.getByText('I can keep working.')).toBeVisible()
  expect(
    screen.getAllByText('Which branch?').filter((element) => !element.closest('[hidden]'))
  ).toHaveLength(1)
  expect(screen.getByTestId('native-chat-question-card-title')).toHaveTextContent('Which branch?')
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'feature' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith('Which branch?\nfeature')
})

it.each([false, true])(
  'keeps readable text without a reply route or in a subagent: %s',
  (subagent) => {
    const row = (
      <MessageRow
        message={message}
        expandSignal={false}
        inSubagentSection={subagent}
        onScrollMessageToTop={vi.fn()}
      />
    )
    render(
      <TooltipProvider>
        {subagent ? (
          <NativeChatAsyncQuestionContext.Provider value={reply}>
            {row}
          </NativeChatAsyncQuestionContext.Provider>
        ) : (
          row
        )}
      </TooltipProvider>
    )
    expect(screen.getByText('Which branch?')).toBeVisible()
    expect(screen.getByText('release')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  }
)
