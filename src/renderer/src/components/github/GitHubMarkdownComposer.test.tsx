// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubMarkdownComposer } from './GitHubMarkdownComposer'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) => selector({ settings: {} })
}))
vi.mock('@/components/editor/RichMarkdownToolbar', () => ({
  RichMarkdownToolbar: () => null
}))
vi.mock('@/components/editor/RichMarkdownTableControls', () => ({
  RichMarkdownTableControls: () => null
}))
vi.mock('@/components/github/github-markdown-composer-preview-pane', () => ({
  GitHubMarkdownComposerPreviewPane: () => null
}))

afterEach(cleanup)

/** Simulates submission so tests can verify draft clearing on success and retention on failure. */
function SubmissionHarness({ success }: { success: boolean }): React.JSX.Element {
  const [body, setBody] = useState('Submitted comment')
  const [submitting, setSubmitting] = useState(false)
  return (
    <>
      <GitHubMarkdownComposer
        value={body}
        onChange={setBody}
        placeholder="Add a comment…"
        disabled={submitting}
      />
      <output data-testid="draft">{body}</output>
      <button onClick={() => setSubmitting(true)}>Start submission</button>
      <button
        onClick={() => {
          if (success) {
            setBody('')
          }
          setSubmitting(false)
        }}
      >
        Finish submission
      </button>
    </>
  )
}

describe('GitHubMarkdownComposer submission', () => {
  it.each([true, false])(
    'keeps the editor and draft synchronized after submission (success: %s)',
    async (success) => {
      const view = render(<SubmissionHarness success={success} />)
      await waitFor(() => {
        expect(view.container.querySelector('.tiptap')?.textContent).toBe('Submitted comment')
      })

      fireEvent.click(view.getByText('Start submission'))
      fireEvent.click(view.getByText('Finish submission'))

      await waitFor(() => {
        const expected = success ? '' : 'Submitted comment'
        expect(view.getByTestId('draft').textContent).toBe(expected)
        expect(view.container.querySelector('.tiptap')?.textContent).toBe(expected)
        expect(view.container.querySelector('.tiptap')?.getAttribute('contenteditable')).toBe(
          'true'
        )
      })
    }
  )

  it('does not report editability changes as draft edits', async () => {
    const onChange = vi.fn()
    const props = { value: 'Draft comment', onChange, placeholder: 'Add a comment…' }
    const view = render(<GitHubMarkdownComposer {...props} />)
    await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
    onChange.mockClear()

    view.rerender(<GitHubMarkdownComposer {...props} disabled />)
    view.rerender(<GitHubMarkdownComposer {...props} disabled={false} />)

    expect(onChange).not.toHaveBeenCalled()
  })
})
