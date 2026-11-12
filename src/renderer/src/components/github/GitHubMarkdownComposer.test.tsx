// @vitest-environment happy-dom

import React from 'react'
import { toast } from 'sonner'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GHCommentComposer } from '@/components/github-item-dialog/discuss-item/gh-comment-composer'
import type { AppState } from '@/store/types'
import type { GitHubCommentResult, PRComment } from '../../../../shared/github/comment-types'
import { GitHubMarkdownComposer } from './GitHubMarkdownComposer'
import type { GitHubImageUploadAddress } from './github-image-upload'

type ComposerStoreState = { settings: Partial<AppState['settings']> }

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: ComposerStoreState) => unknown) => selector({ settings: {} })
}))
vi.mock('@/components/editor/rich-markdown/commands/RichMarkdownToolbar', () => ({
  RichMarkdownToolbar: () => null
}))
vi.mock('@/components/editor/rich-markdown/tables/RichMarkdownTableControls', () => ({
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
  vi.mocked(toast.error).mockClear()
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

const imageUploads = vi.hoisted(() => ({ upload: vi.fn() }))
vi.mock('./github-image-upload', () => ({ captureGitHubImageUpload: () => imageUploads.upload }))

function ImageDraft({ tabbed = false }: { tabbed?: boolean }) {
  const [value, setValue] = React.useState('')
  return (
    <GitHubMarkdownComposer
      value={value}
      onChange={setValue}
      placeholder="Image draft"
      layout={tabbed ? 'tabbed' : 'stacked'}
      imageUploadAddress={{
        runtime: { kind: 'local' },
        target: { kind: 'repo', repo: 'repo', source: 'issue' }
      }}
    />
  )
}

it('uploads pasted files sequentially, keeps placeholders out of Markdown, and replaces duplicate names independently', async () => {
  const first = Promise.withResolvers<string>()
  const second = Promise.withResolvers<string>()
  imageUploads.upload
    .mockReset()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const onChange = vi.fn()
  const view = render(
    <GitHubMarkdownComposer
      value="Before"
      onChange={onChange}
      placeholder="Images"
      imageUploadAddress={{
        runtime: { kind: 'local' },
        target: { kind: 'repo', repo: 'repo', source: 'issue' }
      }}
    />
  )
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  const editor = getComposerEditor(view.container)
  const files = [
    new File(['one'], 'same.png', { type: 'image/png' }),
    new File(['two'], 'same.png', { type: 'image/png' })
  ]
  fireEvent.paste(editor, { clipboardData: { files, getData: () => '' } })
  await waitFor(() => expect(imageUploads.upload).toHaveBeenCalledTimes(1))
  expect(editor.textContent).toContain('Uploading same.png')
  expect(onChange.mock.lastCall?.[0]).not.toContain('Uploading')
  expect(onChange.mock.lastCall?.[0]).not.toContain('data:')
  await act(async () => first.resolve('https://github.com/user-attachments/assets/one'))
  await waitFor(() => expect(imageUploads.upload).toHaveBeenCalledTimes(2))
  await act(async () => second.resolve('https://github.com/user-attachments/assets/two'))
  await waitFor(() => expect(editor.querySelectorAll('img')).toHaveLength(2))
  expect(onChange.mock.lastCall?.[0]).toContain(
    '![same.png](https://github.com/user-attachments/assets/one)'
  )
  expect(onChange.mock.lastCall?.[0]).toContain(
    '![same.png](https://github.com/user-attachments/assets/two)'
  )
})

it('keeps an image-only controlled draft pending and removes failed placeholders before continuing', async () => {
  const first = Promise.withResolvers<string>()
  imageUploads.upload
    .mockReset()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce('https://github.com/user-attachments/assets/two')
  const view = render(<ImageDraft />)
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  const editor = getComposerEditor(view.container)
  fireEvent.paste(editor, {
    clipboardData: {
      files: [
        new File(['a'], 'a.png', { type: 'image/png' }),
        new File(['b'], 'b.png', { type: 'image/png' })
      ],
      getData: () => ''
    }
  })
  await waitFor(() => expect(editor.textContent).toContain('Uploading a.png'))
  await act(async () => first.reject(new Error('Try again')))
  await waitFor(() =>
    expect(editor.querySelector('img')?.getAttribute('src')).toBe(
      'https://github.com/user-attachments/assets/two'
    )
  )
  expect(editor.textContent).not.toContain('Uploading')
})

it('finishes against the same editor while Preview temporarily hides its DOM', async () => {
  const held = Promise.withResolvers<string>()
  imageUploads.upload.mockReset().mockReturnValue(held.promise)
  const view = render(<ImageDraft tabbed />)
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  fireEvent.paste(getComposerEditor(view.container), {
    clipboardData: {
      files: [new File(['a'], 'preview.png', { type: 'image/png' })],
      getData: () => ''
    }
  })
  fireEvent.click(view.getByRole('tab', { name: 'Preview' }))
  await act(async () => held.resolve('https://github.com/user-attachments/assets/preview'))
  fireEvent.click(view.getByRole('tab', { name: 'Write' }))
  await waitFor(() =>
    expect(getComposerEditor(view.container).querySelector('img')?.getAttribute('src')).toBe(
      'https://github.com/user-attachments/assets/preview'
    )
  )
})

it('retains only clean surrounding text when a pending draft is closed and reopened', async () => {
  const held = Promise.withResolvers<string>()
  imageUploads.upload.mockReset().mockReturnValue(held.promise)
  function RetainedDraft() {
    const [value, setValue] = React.useState('Keep this text')
    const [open, setOpen] = React.useState(true)
    return (
      <>
        <button onClick={() => setOpen(!open)}>Toggle</button>
        {open && (
          <GitHubMarkdownComposer
            value={value}
            onChange={setValue}
            placeholder="Retained"
            imageUploadAddress={{
              runtime: { kind: 'local' },
              target: { kind: 'repo', repo: 'repo', source: 'issue' }
            }}
          />
        )}
      </>
    )
  }
  const view = render(<RetainedDraft />)
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  fireEvent.paste(getComposerEditor(view.container), {
    clipboardData: {
      files: [new File(['a'], 'orphan.png', { type: 'image/png' })],
      getData: () => ''
    }
  })
  await waitFor(() => expect(imageUploads.upload).toHaveBeenCalledOnce())
  fireEvent.click(view.getByRole('button', { name: 'Toggle' }))
  fireEvent.click(view.getByRole('button', { name: 'Toggle' }))
  await act(async () => held.resolve('https://github.com/user-attachments/assets/orphan'))
  await waitFor(() => expect(getComposerEditor(view.container).textContent).toBe('Keep this text'))
  expect(getComposerEditor(view.container).querySelector('img')).toBeNull()
})

it('gives image Files precedence over the same image in clipboard HTML', async () => {
  imageUploads.upload
    .mockReset()
    .mockResolvedValue('https://github.com/user-attachments/assets/mixed')
  const view = render(<ImageDraft />)
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  fireEvent.paste(getComposerEditor(view.container), {
    clipboardData: {
      files: [new File(['png'], 'mixed.png', { type: 'image/png' })],
      getData: (type: string) =>
        type === 'text/html' ? '<p><img src="data:image/png;base64,AQID"></p>' : ''
    }
  })
  await waitFor(() =>
    expect(getComposerEditor(view.container).querySelector('img')?.getAttribute('src')).toBe(
      'https://github.com/user-attachments/assets/mixed'
    )
  )
  expect(imageUploads.upload).toHaveBeenCalledOnce()
  expect(toast.error).not.toHaveBeenCalled()
})

it('refuses normalized data-image HTML without dropping surrounding text', async () => {
  imageUploads.upload.mockReset()
  const onChange = vi.fn()
  const view = render(
    <GitHubMarkdownComposer value="" onChange={onChange} placeholder="HTML image" />
  )
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  fireEvent.paste(getComposerEditor(view.container), {
    clipboardData: {
      files: [],
      getData: (type: string) =>
        type === 'text/html'
          ? '<p>before<img src=" data:image/png;base64,AQID" alt="screen">after</p>'
          : ''
    }
  })
  await waitFor(() => expect(onChange).toHaveBeenCalled())
  expect(onChange.mock.lastCall?.[0]).toBe('beforeafter')
  expect(getComposerEditor(view.container).querySelector('img')).toBeNull()
  expect(toast.error).toHaveBeenCalledOnce()
  expect(imageUploads.upload).not.toHaveBeenCalled()
})

it('shows a failed hosted image as its filename link without changing the uploaded Markdown', async () => {
  imageUploads.upload
    .mockReset()
    .mockResolvedValue('https://github.com/user-attachments/assets/private')
  const onChange = vi.fn()
  const imageUploadAddress: GitHubImageUploadAddress = {
    runtime: { kind: 'local' },
    target: { kind: 'repo', repo: 'repo', source: 'issue' }
  }
  const view = render(
    <GitHubMarkdownComposer
      value=""
      onChange={onChange}
      placeholder="Private image"
      imageUploadAddress={imageUploadAddress}
    />
  )
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  const editor = getComposerEditor(view.container)
  fireEvent.paste(editor, {
    clipboardData: {
      files: [new File(['png'], 'screen.png', { type: 'image/png' })],
      getData: () => ''
    }
  })
  await waitFor(() =>
    expect(editor.querySelector('img')?.getAttribute('src')).toBe(
      'https://github.com/user-attachments/assets/private'
    )
  )
  const image = editor.querySelector('img')
  if (!image) {
    throw new Error('Uploaded image missing')
  }
  fireEvent.error(image)
  const link = view.getByRole('link', { name: 'screen.png' })
  expect(link.getAttribute('href')).toBe('https://github.com/user-attachments/assets/private')
  expect(image.hidden).toBe(true)
  expect(onChange.mock.lastCall?.[0]).toBe(
    '![screen.png](https://github.com/user-attachments/assets/private)'
  )
  fireEvent.focus(window)
  expect(image.hidden).toBe(true)
  expect(view.getByRole('link', { name: 'screen.png' })).toBe(link)
  view.rerender(
    <GitHubMarkdownComposer
      value="![renamed.png](https://github.com/user-attachments/assets/private)"
      onChange={onChange}
      placeholder="Private image"
      imageUploadAddress={imageUploadAddress}
    />
  )
  await waitFor(() => expect(view.getByRole('link', { name: 'renamed.png' })).toBe(link))
  expect(image.alt).toBe('renamed.png')
  expect(image.hidden).toBe(true)
  fireEvent.load(image)
  expect(image.hidden).toBe(false)
  expect(view.queryByRole('link', { name: 'renamed.png' })).toBeNull()
})
