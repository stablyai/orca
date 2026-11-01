// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GHCommentComposer } from '@/components/github-item-dialog/discuss-item/gh-comment-composer'
import type { AppState } from '@/store/types'
import type { GitHubCommentResult, PRComment } from '../../../../shared/github/comment-types'
import { GitHubMarkdownComposer } from './GitHubMarkdownComposer'

type ComposerStoreState = { settings: Partial<AppState['settings']> }

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: ComposerStoreState) => unknown) => selector({ settings: {} })
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
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const addIssueComment = vi.fn<typeof window.api.gh.addIssueComment>()
const comment: PRComment = {
  id: 29533,
  author: 'test-author',
  authorAvatarUrl: '',
  body: 'Submitted comment',
  createdAt: '2026-10-23T12:00:00Z',
  url: ''
}

beforeEach(() => {
  addIssueComment.mockReset()
  vi.stubGlobal('api', { gh: { addIssueComment } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function getComposerEditor(container: HTMLElement): HTMLElement {
  const editor = container.querySelector<HTMLElement>('.tiptap')
  if (!editor) {
    throw new Error('Composer editor did not mount')
  }
  return editor
}

async function enterComment(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(container.querySelector('.tiptap')).not.toBeNull())
  fireEvent.input(getComposerEditor(container), {
    target: { innerHTML: '<p>Submitted comment</p>' }
  })
}

function renderCommentSubmission() {
  const onCommentAdded = vi.fn()
  const view = render(
    <TooltipProvider>
      <GHCommentComposer
        repoPath="/folder-workspace"
        issueNumber={29521}
        itemType="issue"
        onCommentAdded={onCommentAdded}
      />
    </TooltipProvider>
  )
  return { ...view, onCommentAdded }
}

describe('GitHubMarkdownComposer submission', () => {
  it('clears the real submission owner and editor after a successful request', async () => {
    const request = Promise.withResolvers<GitHubCommentResult>()
    addIssueComment.mockReturnValue(request.promise)
    const view = renderCommentSubmission()
    const send = view.getByRole('button', { name: 'Send comment' })
    await enterComment(view.container)
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false))
    fireEvent.click(send)
    await waitFor(() =>
      expect(getComposerEditor(view.container).getAttribute('contenteditable')).toBe('false')
    )
    expect(send.hasAttribute('disabled')).toBe(true)
    expect(addIssueComment).toHaveBeenCalledOnce()
    expect(addIssueComment.mock.calls[0]?.[0].body).toBe('Submitted comment')

    await act(async () => request.resolve({ ok: true, comment }))

    await waitFor(() => {
      expect(getComposerEditor(view.container).textContent).toBe('')
      expect(getComposerEditor(view.container).getAttribute('contenteditable')).toBe('true')
      expect(send.hasAttribute('disabled')).toBe(true)
    })
    expect(view.onCommentAdded).toHaveBeenCalledExactlyOnceWith(comment)
  })

  it.each(['result-error', 'rejection'])(
    'preserves a failed draft for retry (%s)',
    async (kind) => {
      const request = Promise.withResolvers<GitHubCommentResult>()
      addIssueComment.mockReturnValueOnce(request.promise)
      const view = renderCommentSubmission()
      const send = view.getByRole('button', { name: 'Send comment' })
      await enterComment(view.container)
      await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false))
      fireEvent.click(send)
      await waitFor(() =>
        expect(getComposerEditor(view.container).getAttribute('contenteditable')).toBe('false')
      )

      await act(async () => {
        if (kind === 'rejection') {
          request.reject(new Error('Request failed'))
        } else {
          request.resolve({ ok: false, error: 'Request failed' })
        }
      })

      await waitFor(() => {
        expect(getComposerEditor(view.container).textContent).toBe('Submitted comment')
        expect(getComposerEditor(view.container).getAttribute('contenteditable')).toBe('true')
        expect(send.hasAttribute('disabled')).toBe(false)
      })
      expect(view.onCommentAdded).not.toHaveBeenCalled()
      const retry = Promise.withResolvers<GitHubCommentResult>()
      addIssueComment.mockReturnValueOnce(retry.promise)
      fireEvent.click(send)
      await waitFor(() =>
        expect(getComposerEditor(view.container).getAttribute('contenteditable')).toBe('false')
      )
      await act(async () => retry.resolve({ ok: true, comment }))
      await waitFor(() => {
        expect(getComposerEditor(view.container).textContent).toBe('')
        expect(send.hasAttribute('disabled')).toBe(true)
      })
      expect(view.onCommentAdded).toHaveBeenCalledExactlyOnceWith(comment)
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

  it('accepts an external nonempty value while editability changes', async () => {
    const onChange = vi.fn()
    const props = { value: 'Original description', onChange, placeholder: 'Description' }
    const view = render(<GitHubMarkdownComposer {...props} />)
    await waitFor(() => expect(getComposerEditor(view.container).textContent).toBe(props.value))
    onChange.mockClear()

    view.rerender(<GitHubMarkdownComposer {...props} value="Updated description" disabled />)
    await waitFor(() =>
      expect(getComposerEditor(view.container).textContent).toBe('Updated description')
    )
    view.rerender(
      <GitHubMarkdownComposer {...props} value="Updated description" disabled={false} />
    )

    expect(getComposerEditor(view.container).getAttribute('contenteditable')).toBe('true')
    expect(onChange).not.toHaveBeenCalled()
  })
})
