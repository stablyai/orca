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
  it('names a failed run and opens the run', () => {
    renderRow(<NativeChatAutomationResultRow note={note({ outcome: 'couldNotFinish' })} />)

    fireEvent.click(screen.getByRole('button', { name: /Hook echo\. Couldn't finish/ }))
    fireEvent.click(screen.getByRole('button', { name: /Open run/ }))

    expect(openBotAutomation).toHaveBeenCalledWith('auto-1', 'run-1')
  })
})
