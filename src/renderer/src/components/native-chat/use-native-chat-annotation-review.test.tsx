// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useNativeChatAnnotationReview } from './use-native-chat-annotation-review'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { getNativeChatAnnotationsStore } from './native-chat-annotations-store'
vi.mock('react-i18next', () => ({ useTranslation: () => ({}) }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: { count: number }) =>
    fallback.replace('{{count}}', String(values?.count))
}))
const appendText = vi.fn()
const composer: NativeChatComposerHandle = {
  appendText,
  acceptsText: () => true,
  focus: () => true,
  insertTypedText: () => true,
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false
}
function Harness({ scopeKey }: { scopeKey: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const review = useNativeChatAnnotationReview({
    scopeKey,
    rootRef,
    composerRef: { current: composer },
    enabled: true
  })
  return (
    <TooltipProvider>
      <div ref={rootRef}>
        <div data-native-chat-message-id="reply">
          <p data-native-chat-quote-source="">first sentence. second sentence.</p>
        </div>
        <button
          onClick={() =>
            review.begin?.({ messageId: 'reply', quote: 'first sentence.', startOffset: 0 })
          }
        >
          First
        </button>
        <button
          onClick={() =>
            review.begin?.({ messageId: 'reply', quote: 'second sentence.', startOffset: 16 })
          }
        >
          Second
        </button>
        {review.tray}
      </div>
    </TooltipProvider>
  )
}
function comment(text: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: text } })
}
function openNotes(count = 1): void {
  fireEvent.click(
    screen.getByRole('button', { name: count === 1 ? '1 annotation' : `${count} annotations` })
  )
}
function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Save annotation' }))
}
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  appendText.mockClear()
})

describe('conversation annotation review', () => {
  it('edits beside the passage and keeps saved notes behind a count without inserting text', () => {
    render(<Harness scopeKey="review-count" />)
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    expect(screen.getByRole('dialog', { name: 'Comment' })).toBeTruthy()
    comment('Explain the mechanism.')
    save()
    expect(screen.getByRole('button', { name: '1 annotation' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull()
    expect(screen.queryByText('Explain the mechanism.')).toBeNull()
    expect(appendText).not.toHaveBeenCalled()
    openNotes()
    expect(screen.getByText('Explain the mechanism.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation' }))
    comment('Explain the control effect.')
    save()
    openNotes()
    expect(screen.getByText('Explain the control effect.')).toBeTruthy()
    expect(screen.queryByText('Explain the mechanism.')).toBeNull()
  })

  it('restores saved notes, isolates conversations and deletes only the chosen note', () => {
    const view = render(<Harness scopeKey="review-restore" />)
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    comment('Keep this note.')
    save()
    view.rerender(<Harness scopeKey="another-conversation" />)
    expect(screen.queryByRole('button', { name: '1 annotation' })).toBeNull()
    view.rerender(<Harness scopeKey="review-restore" />)
    openNotes()
    expect(screen.getByText('Keep this note.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }))
    expect(screen.queryByRole('button', { name: '1 annotation' })).toBeNull()
  })

  it('saves an unfinished nonempty comment when annotating another passage', () => {
    render(<Harness scopeKey="review-selection-change" />)
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    comment('Preserve my current comment.')
    fireEvent.click(screen.getByRole('button', { name: 'Second' }))
    expect(
      getNativeChatAnnotationsStore('review-selection-change').getSnapshot().notes[0]?.comment
    ).toBe('Preserve my current comment.')
    expect(screen.getByRole('textbox', { name: 'Comment' }).getAttribute('value') ?? '').toBe('')
  })

  it('restores unfinished comments after remount and when switching conversations', () => {
    const view = render(<Harness scopeKey="review-draft-remount" />)
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    comment('Preserve this unfinished draft.')
    view.rerender(<Harness scopeKey="review-draft-other" />)
    fireEvent.click(screen.getByRole('button', { name: 'Second' }))
    comment('Another conversation draft.')
    view.rerender(<Harness scopeKey="review-draft-remount" />)
    const input = screen.getByRole('textbox', { name: 'Comment' })
    expect(input instanceof HTMLTextAreaElement && input.value).toBe(
      'Preserve this unfinished draft.'
    )
    view.unmount()
    render(<Harness scopeKey="review-draft-remount" />)
    const restored = screen.getByRole('textbox', { name: 'Comment' })
    expect(restored instanceof HTMLTextAreaElement && restored.value).toBe(
      'Preserve this unfinished draft.'
    )
  })

  it('recovers the edited comment when another pane deletes the saved note', () => {
    render(<Harness scopeKey="review-deleted-while-editing" />)
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    comment('Original comment.')
    save()
    openNotes()
    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation' }))
    comment('Keep the current edit.')
    const store = getNativeChatAnnotationsStore('review-deleted-while-editing')
    act(() => {
      store.remove(store.getSnapshot().notes[0].id)
    })
    save()
    openNotes()
    expect(screen.getByText('Keep the current edit.')).toBeTruthy()
  })

  it('shows legacy notes, the unfinished editor and retry when migration cannot write', () => {
    const scope = 'review-refused-migration'
    const anchor = { messageId: 'reply', quote: 'first sentence.', startOffset: 0 }
    localStorage.setItem(
      `orca:native-chat-annotations:v1:${scope}`,
      JSON.stringify({
        version: 1,
        notes: [{ ...anchor, id: 'legacy', comment: 'Saved legacy comment', createdAt: 1 }],
        editor: { anchor, comment: 'Unfinished legacy editor' }
      })
    )
    const blocked = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Full')
    })
    render(<Harness scopeKey={scope} />)
    expect(screen.getByRole('button', { name: '1 annotation' })).toBeTruthy()
    const input = screen.getByRole('textbox', { name: 'Comment' })
    expect(input instanceof HTMLTextAreaElement && input.value).toBe('Unfinished legacy editor')
    expect(screen.getByRole('status').textContent).toContain('Annotations could not be saved')
    blocked.mockRestore()
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving annotations' }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    openNotes()
    expect(screen.getByText('Saved legacy comment')).toBeTruthy()
  })

  it('keeps an error and retry visible even when no annotations could be read', () => {
    const scope = 'review-unreadable-migration'
    localStorage.setItem(`orca:native-chat-annotations:v1:${scope}`, '{invalid')
    render(<Harness scopeKey={scope} />)
    expect(screen.getByRole('status')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving annotations' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
