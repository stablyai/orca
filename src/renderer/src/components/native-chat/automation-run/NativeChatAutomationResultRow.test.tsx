// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeAutomationResultNote,
  type AutomationResultNote
} from '../../../../../shared/bots/bot-automation-result-note'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatAutomationResultRow } from './NativeChatAutomationResultRow'

// The app's root provides tooltips; a row alone needs its own.
const renderRow = (row: React.ReactElement) => render(<TooltipProvider>{row}</TooltipProvider>)

const { openBotAutomation } = vi.hoisted(() => ({ openBotAutomation: vi.fn() }))
vi.mock('@/components/bots/bot-automation-open', () => ({ openBotAutomation }))
vi.mock('../markdown/NativeChatMarkdown', () => ({
  NativeChatMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

afterEach(() => {
  cleanup()
  openBotAutomation.mockReset()
})

function note(overrides: Partial<AutomationResultNote> = {}): AutomationResultNote {
  return {
    ...makeAutomationResultNote({
      automationId: 'auto-1',
      automationName: 'Hook echo',
      botName: 'Atlas',
      runId: 'run-1',
      trigger: 'event',
      outcome: 'finished',
      result: 'got: hello\n\nservice: api',
      at: 1_000
    }),
    ...overrides
  }
}

describe('NativeChatAutomationResultRow', () => {
  it('opens into the result with its read caption', () => {
    renderRow(<NativeChatAutomationResultRow note={note()} />)

    const row = screen.getByRole('button', { name: /Hook echo\. Finished/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/hasn't read this yet/)).toBeNull()

    fireEvent.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/service: api/)).toBeInTheDocument()
    expect(
      screen.getByText("Atlas hasn't read this yet. It goes with your next message.")
    ).toBeInTheDocument()
  })

  it('says the bot read it once a message carried it', () => {
    renderRow(<NativeChatAutomationResultRow note={note({ readWith: 'message-1' })} />)
    fireEvent.click(screen.getByRole('button', { name: /Hook echo\. Finished/ }))

    expect(screen.getByText('Atlas read this with your next message.')).toBeInTheDocument()
  })

  it('says a note a later /clear left unread will never reach the bot', () => {
    renderRow(<NativeChatAutomationResultRow note={note()} cleared />)
    fireEvent.click(screen.getByRole('button', { name: /Hook echo\. Finished/ }))

    expect(
      screen.getByText("Arrived before the chat was cleared. It won't go to Atlas.")
    ).toBeInTheDocument()
  })

  it('names a failed run and opens the run', () => {
    renderRow(<NativeChatAutomationResultRow note={note({ outcome: 'couldNotFinish' })} />)

    fireEvent.click(screen.getByRole('button', { name: /Hook echo\. Couldn't finish/ }))
    fireEvent.click(screen.getByRole('button', { name: /Open run/ }))

    expect(openBotAutomation).toHaveBeenCalledWith('auto-1', 'run-1')
  })
})
