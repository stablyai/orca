// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { TEXT_CONTROL_PASTE_MAX_BYTES } from '@/lib/text-control-paste-model'
import { DashboardPopoutRoot } from './DashboardPopoutRoot'

vi.mock('./useDashboardSnapshot', () => ({
  useDashboardSnapshot: () => ({ generatedAt: 1, cards: [] })
}))
vi.mock('./use-agent-dashboard-telemetry', () => ({ useAgentDashboardTelemetry: () => {} }))
vi.mock('./AgentTerminalDialog', () => ({ AgentTerminalDialog: () => null }))
vi.mock('./AgentKanbanCard', () => ({ AgentKanbanCard: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function pasteEvent(text: string): ClipboardEvent {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  return new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
}

beforeEach(() => {
  Object.assign(window, {
    api: {
      ui: {
        onEditableContextPaste: () => () => {},
        onAppMenuSelectionAction: () => () => {}
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('rejects an oversized paste without changing the popout search query', () => {
  const view = render(<DashboardPopoutRoot />)
  const search = view.getByRole('textbox', { name: 'Search agents' })
  fireEvent.change(search, { target: { value: 'safe' } })
  search.focus()
  const text = 'x'.repeat(TEXT_CONTROL_PASTE_MAX_BYTES + 1)
  const event = pasteEvent(text)

  act(() => search.dispatchEvent(event))

  expect(event.defaultPrevented).toBe(true)
  expect(search).toHaveValue('safe')
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('Paste is too large.')

  view.unmount()
  const unguarded = document.createElement('input')
  document.body.appendChild(unguarded)
  unguarded.focus()
  const afterUnmount = pasteEvent(text)
  unguarded.dispatchEvent(afterUnmount)
  expect(afterUnmount.defaultPrevented).toBe(false)
  unguarded.remove()
})
