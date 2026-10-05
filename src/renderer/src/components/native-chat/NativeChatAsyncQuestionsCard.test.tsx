// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatAsyncQuestionsCard } from './NativeChatAsyncQuestionsCard'
import type { NativeChatAsyncQuestionsCardModel } from './use-native-chat-async-questions'

afterEach(cleanup)

function model(
  overrides: Partial<NativeChatAsyncQuestionsCardModel> = {}
): NativeChatAsyncQuestionsCardModel {
  return {
    open: [
      { key: 'a', index: 0, title: 'Which color?', options: ['Red', 'Blue'] },
      { key: 'b', index: 1, title: 'Anything else?' }
    ],
    omittedCount: 0,
    edits: {},
    held: new Set(),
    sending: false,
    canSend: false,
    edit: vi.fn(),
    dismiss: vi.fn(),
    submit: vi.fn(),
    ...overrides
  }
}

describe('NativeChatAsyncQuestionsCard', () => {
  it('renders every question with its choices and a free-text field', () => {
    render(<NativeChatAsyncQuestionsCard model={model()} />)
    expect(screen.getByText('Which color?')).toBeTruthy()
    expect(screen.getByText('Anything else?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Red' })).toBeTruthy()
    expect(screen.getAllByPlaceholderText('Type your answer')).toHaveLength(2)
  })

  it('picks a choice, types an answer and dismisses per question', () => {
    const card = model()
    render(<NativeChatAsyncQuestionsCard model={card} />)
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    expect(card.edit).toHaveBeenCalledWith('a', { option: 'Blue' })
    fireEvent.change(screen.getAllByPlaceholderText('Type your answer')[1]!, {
      target: { value: 'no' }
    })
    expect(card.edit).toHaveBeenCalledWith('b', { text: 'no' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[1]!)
    expect(card.dismiss).toHaveBeenCalledWith('b')
  })

  it('sends only when the model allows it, and disables input while sending', () => {
    const idle = model()
    const { rerender } = render(<NativeChatAsyncQuestionsCard model={idle} />)
    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    const ready = model({ canSend: true })
    rerender(<NativeChatAsyncQuestionsCard model={ready} />)
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(ready.submit).toHaveBeenCalledOnce()
    rerender(<NativeChatAsyncQuestionsCard model={model({ sending: true })} />)
    expect(screen.getByRole('button', { name: 'Sending…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Red' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows a held answer read-only while Dismiss and every other question stay usable', () => {
    const card = model({ edits: { a: { option: 'Red' } }, held: new Set(['a']) })
    render(<NativeChatAsyncQuestionsCard model={card} />)
    expect(screen.getByRole('button', { name: 'Red' }).hasAttribute('disabled')).toBe(true)
    const [heldInput, openInput] = screen.getAllByPlaceholderText('Type your answer')
    expect(heldInput!.hasAttribute('disabled')).toBe(true)
    expect(openInput!.hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
    for (const dismiss of screen.getAllByRole('button', { name: 'Dismiss' })) {
      expect(dismiss.hasAttribute('disabled')).toBe(false)
    }
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!)
    expect(card.dismiss).toHaveBeenCalledWith('a')
  })

  it('says how many questions were left out of the published set, singular for one', () => {
    const { rerender } = render(<NativeChatAsyncQuestionsCard model={model({ omittedCount: 3 })} />)
    expect(screen.getByText('3 more questions in the transcript')).toBeTruthy()
    rerender(<NativeChatAsyncQuestionsCard model={model({ omittedCount: 1 })} />)
    expect(screen.getByText('1 more question in the transcript')).toBeTruthy()
  })

  it('renders a choice the model repeated once per occurrence, each with its own key', () => {
    const keyWarning = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <NativeChatAsyncQuestionsCard
        model={model({ open: [{ key: 'a', index: 0, title: 'Pick', options: ['Yes', 'Yes'] }] })}
      />
    )
    expect(screen.getAllByRole('button', { name: 'Yes' })).toHaveLength(2)
    expect(keyWarning.mock.calls.flat().join(' ')).not.toContain('same key')
    keyWarning.mockRestore()
  })

  it('renders nothing when no question is open', () => {
    const { container } = render(<NativeChatAsyncQuestionsCard model={model({ open: [] })} />)
    expect(container.innerHTML).toBe('')
  })
})
