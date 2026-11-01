// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageRow } from './NativeChatMessageRow'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))

afterEach(cleanup)
function row(
  role: NativeChatMessage['role'],
  disabledReason: string | null = null,
  enabled = true
) {
  const request = vi.fn()
  render(
    <TooltipProvider>
      <MessageRow
        message={{
          id: 'user-1',
          role,
          timestamp: 1,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Prompt' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
        rewind={enabled ? { request, disabledReason } : undefined}
      />
    </TooltipProvider>
  )
  return request
}
describe('user-row rewind affordance', () => {
  it('exposes the disabled reason to keyboard users and cannot invoke rewind', async () => {
    const request = row('user', 'Wait for the current turn to finish first.')
    const button = screen.getByRole('button', { name: 'Rewind to here' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-description', 'Wait for the current turn to finish first.')
    act(() => button.focus())
    expect(button).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Wait for the current turn to finish first.'
    )
    fireEvent.click(button)
    expect(request).not.toHaveBeenCalled()
  })
})
