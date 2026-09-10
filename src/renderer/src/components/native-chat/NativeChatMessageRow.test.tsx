// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'

afterEach(cleanup)

function renderMessage(role: NativeChatMessage['role'], timestamp: number | null = 0) {
  return render(
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
    />
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
    expect(time).toHaveClass(
      'can-hover:opacity-0',
      'can-hover:pointer-events-none',
      'group-hover:opacity-100',
      'group-has-[:focus-visible]:opacity-100',
      'group-hover:pointer-events-auto',
      'group-has-[:focus-visible]:pointer-events-auto'
    )
    expect(time).not.toHaveClass('opacity-0', 'pointer-events-none')
    expect(time.parentElement).toHaveClass('group')
    time.focus()
    expect(time).toHaveFocus()
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

describe('MessageRow fork control', () => {
  it('lives inside the hover/focus cluster rather than standing beside the row', () => {
    const onFork = vi.fn()
    render(
      <MessageRow
        message={{
          id: 'message',
          role: 'assistant',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Message text' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
        forkEligible
        onFork={onFork}
      />
    )
    const copy = screen.getByRole('button', { name: 'Copy message' })
    const scroll = screen.getByRole('button', { name: 'Scroll this message to top' })
    const fork = screen.getByRole('button', { name: 'Fork from this turn' })
    const time = screen.getByRole('time')
    // Same parent as copy, so it inherits that cluster's reveal instead of duplicating the classes.
    expect(Array.from(copy.parentElement!.children)).toEqual([copy, scroll, fork, time])
    expect(fork.parentElement).toHaveClass(
      'can-hover:opacity-0',
      'group-hover:opacity-100',
      'group-has-[:focus-visible]:opacity-100',
      'group-has-[:focus-visible]:pointer-events-auto'
    )
    // The keyboard half of that pattern only works if the control itself can take focus.
    fork.focus()
    expect(fork).toHaveFocus()
    fork.click()
    expect(onFork).toHaveBeenCalledExactlyOnceWith('message')
  })

  it('draws no fork control on a row that does not anchor a forkable turn', () => {
    renderMessage('assistant')
    expect(screen.queryByRole('button', { name: 'Fork from this turn' })).toBeNull()
  })
})
