// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  return screen.getByRole('textbox') as HTMLTextAreaElement
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
