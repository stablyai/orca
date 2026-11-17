// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { useRetainedDiffCommentField } from './retained-diff-comment-drafts'
import { afterEach, describe, expect, it } from 'vitest'
import { DiffCommentDraftCard } from './DiffCommentDraftCard'

const RETAIN_KEY = 'note:tab-1:file.ts:compose:4-4'

function renderDraft(onCancel: () => void = () => {}) {
  render(
    <DiffCommentDraftCard
      lineNumber={4}
      retainKey={RETAIN_KEY}
      onCancel={onCancel}
      onSubmit={async () => true}
    />
  )
  const textarea = screen.getByRole('textbox')
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('expected the note textarea')
  }
  return textarea
}

describe('retained note drafts', () => {
  afterEach(cleanup)

  it('restores text, caret and focus after the row unmounts', () => {
    const textarea = renderDraft()
    fireEvent.change(textarea, { target: { value: 'half a thought' } })
    textarea.setSelectionRange(5, 7)
    cleanup()

    const restored = renderDraft()
    expect(restored.value).toBe('half a thought')
    expect(document.activeElement).toBe(restored)
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([5, 7])
  })

  it('forgets a cancelled draft', () => {
    const textarea = renderDraft()
    fireEvent.change(textarea, { target: { value: 'discard me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    cleanup()

    expect(renderDraft().value).toBe('')
  })
})

it('retains the canonical body instead of an in-flight image display placeholder', () => {
  let restored: string | undefined
  function Field({ uploading }: { uploading: boolean }) {
    const retained = useRetainedDiffCommentField('upload-retention')
    restored = retained.initialBody
    useLayoutEffect(() => {
      retained.setBody('my note')
    }, [retained])
    return (
      <textarea
        ref={retained.bind}
        defaultValue={uploading ? 'my note ![Uploading image.png…]()' : retained.initialBody}
        onFocus={retained.onFocus}
      />
    )
  }
  const view = render(<Field uploading />)
  fireEvent.focus(screen.getByRole('textbox'))
  view.unmount()
  render(<Field uploading={false} />)
  expect(restored).toBe('my note')
  expect(screen.getByRole('textbox').textContent).toBe('my note')
})
