// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it.each(['```sh\necho $1\n', '    echo $1\n'])(
    'preserves shell dollars when rendering and copying code: %s',
    async (content) => {
      const writeClipboardText = vi.fn().mockResolvedValue(undefined)
      Object.assign(window, { api: { ui: { writeClipboardText } } })

      render(
        <MessageRow
          message={{
            id: 'message',
            role: 'assistant',
            timestamp: 0,
            source: 'transcript',
            blocks: [{ type: 'text', text: content }]
          }}
          expandSignal={false}
          onScrollMessageToTop={vi.fn()}
        />
      )

      expect(document.querySelector('pre')?.textContent).toContain('echo $1')
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

      await waitFor(() => {
        expect(writeClipboardText).toHaveBeenCalledWith('echo $1\n')
      })
    }
  )

  it('renders assistant math while preserving currency dollar signs', () => {
    render(
      <MessageRow
        message={{
          id: 'message',
          role: 'assistant',
          timestamp: 0,
          source: 'transcript',
          blocks: [
            {
              type: 'text',
              text: String.raw`Confidence: $P = \text{Success}$. Cost: $148+ → $19.`
            }
          ]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )

    expect(document.querySelector('.katex')).not.toBeNull()
    expect(document.body.textContent).toContain('Success')
    expect(document.body.textContent).toContain('Cost: $148+ → $19.')
  })

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

  it('gives user bubbles a copy button and timestamp that only hide on hover-capable devices', () => {
    renderMessage('user')
    const copy = screen.getByRole('button', { name: 'Copy message' })
    const time = screen.getByRole('time')
    expect(Array.from(copy.parentElement!.children)).toEqual([copy, time])
    expect(copy.parentElement).toHaveClass(
      'can-hover:opacity-0',
      'can-hover:pointer-events-none',
      'group-hover:opacity-100',
      'group-has-[:focus-visible]:opacity-100',
      'group-hover:pointer-events-auto',
      'group-has-[:focus-visible]:pointer-events-auto'
    )
    expect(copy.parentElement).not.toHaveClass('opacity-0', 'pointer-events-none')
    expect(copy.parentElement!.parentElement).toHaveClass('group')
    time.focus()
    expect(time).toHaveFocus()
  })

  it('copies the sent message text from a user bubble', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })

    renderMessage('user')
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('Message text')
    })
  })

  it('omits the copy button on image-only user messages', () => {
    render(
      <MessageRow
        message={{
          id: 'message',
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'image-ref', path: '/tmp/screenshot.png', alt: 'Screenshot' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
    expect(screen.getByRole('time')).toBeInTheDocument()
  })

  it.each(['assistant', 'user'] as const)('omits unknown timestamps on %s rows', (role) => {
    renderMessage(role, null)
    expect(screen.queryByRole('time')).toBeNull()
    expect(screen.getByText('Message text')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(role === 'assistant' ? 2 : 1)
  })

  it.each(['reasoning', 'system'] as const)('preserves chrome-free %s rows', (role) => {
    renderMessage(role)
    expect(screen.queryByRole('time')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('MessageRow send mode', () => {
  function renderUser(sentAs?: NativeChatMessage['sentAs']) {
    return render(
      <MessageRow
        message={{
          id: 'message',
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Ship the parser' }],
          ...(sentAs ? { sentAs } : {})
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
  }

  it('marks a user message that was sent as a goal', () => {
    renderUser('goal')
    expect(screen.getByText('Ship the parser')).toBeInTheDocument()
    expect(screen.getByText('Sent as goal')).toBeInTheDocument()
  })

  it('leaves an ordinary user message unmarked', () => {
    renderUser()
    expect(screen.queryByText('Sent as goal')).not.toBeInTheDocument()
  })
})
