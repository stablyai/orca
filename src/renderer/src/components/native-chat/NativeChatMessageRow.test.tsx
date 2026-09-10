// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'

afterEach(cleanup)

function renderMessage(
  role: NativeChatMessage['role'],
  timestamp: number | null = 0,
  rewind?: NativeChatRewindSurface
) {
  return render(
    <TooltipProvider>
      <MessageRow
        message={{
          id: 'message',
          role,
          timestamp,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Message text' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
        rewind={rewind}
      />
    </TooltipProvider>
  )
}

describe('MessageRow control visibility', () => {
  it('appends time to the existing agent controls and inherits their reveal', () => {
    renderMessage('assistant')
    const copy = screen.getByRole('button', { name: 'Copy message' })
    const scroll = screen.getByRole('button', { name: 'Scroll this message to top' })
    const time = screen.getByRole('time')
    expect(Array.from(copy.parentElement!.children)).toEqual([copy, scroll, time])
    expect(copy.parentElement).toHaveClass(
      'can-hover:opacity-0',
      'can-hover:pointer-events-none',
      'group-hover:opacity-100',
      'group-has-[:focus-visible]:opacity-100',
      'group-hover:pointer-events-auto',
      'group-has-[:focus-visible]:pointer-events-auto'
    )
    expect(copy.parentElement).not.toHaveClass('opacity-0', 'pointer-events-none')
    expect(time).not.toHaveAttribute('tabindex')
    copy.focus()
    expect(copy).toHaveFocus()
  })

  it('gives user bubbles a timestamp that only hides on hover-capable devices', () => {
    renderMessage('user')
    const time = screen.getByRole('time')
    expect(screen.queryByRole('button')).toBeNull()
    expect(time.parentElement).toHaveClass(
      'can-hover:opacity-0',
      'can-hover:pointer-events-none',
      'group-hover:opacity-100',
      'group-has-[:focus-visible]:opacity-100',
      'group-hover:pointer-events-auto',
      'group-has-[:focus-visible]:pointer-events-auto'
    )
    expect(time.parentElement).not.toHaveClass('opacity-0', 'pointer-events-none')
    expect(time.parentElement?.parentElement).toHaveClass('group')
    time.focus()
    expect(time).toHaveFocus()
  })

  it('composes the user timestamp and revert action in one hover/focus strip', () => {
    const request = vi.fn()
    renderMessage('user', 0, { disabledReason: null, request })
    const time = screen.getByRole('time')
    const revert = screen.getByRole('button', { name: 'Revert to here' })
    expect(Array.from(time.parentElement!.children)).toEqual([time, revert])
    expect(time.parentElement).toHaveClass(
      'can-hover:opacity-0',
      'group-hover:opacity-100',
      'group-has-[:focus-visible]:opacity-100'
    )
    time.focus()
    expect(time).toHaveFocus()
    revert.focus()
    expect(revert).toHaveFocus()
    fireEvent.click(revert)
    expect(request).toHaveBeenCalledWith('message')
  })

  it.each(['assistant', 'user'] as const)('omits unknown timestamps on %s rows', (role) => {
    renderMessage(role, null)
    expect(screen.queryByRole('time')).toBeNull()
    expect(screen.getByText('Message text')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(role === 'assistant' ? 2 : 0)
  })

  it.each(['reasoning', 'system'] as const)('preserves chrome-free %s rows', (role) => {
    renderMessage(role)
    expect(screen.queryByRole('time')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
