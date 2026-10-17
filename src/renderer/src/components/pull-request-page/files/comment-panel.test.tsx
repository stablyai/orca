// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { PRFilesReviewLayout } from './review-layout'
import { TooltipProvider } from '@/components/ui/tooltip'

const mutations = vi.hoisted(() => ({ add: vi.fn() }))
vi.mock('@/components/github/github-work-item-comment-mutations', () => ({
  addIssueCommentForRepo: mutations.add
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/github-source-runtime-context', () => ({
  canUseGitHubRepoContext: (repoPath: string | null, context: { hostId?: string } | null) =>
    Boolean(repoPath) || context?.hostId?.startsWith('runtime:') === true
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>
}))
vi.mock('@/components/github/github-user-avatar', () => ({ GitHubUserAvatar: () => null }))

const item: GitHubWorkItem = {
  id: 'pr-7',
  type: 'pr',
  number: 7,
  title: 'Improve review',
  state: 'open',
  url: 'https://github.com/example/project/pull/7',
  labels: [],
  updatedAt: '2026-10-01T00:00:00Z',
  author: 'reviewer',
  repoId: 'repo-1'
}
const comment: PRComment = {
  id: 1,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Keep this behavior.',
  createdAt: item.updatedAt,
  url: `${item.url}#issuecomment-1`
}
const props: React.ComponentProps<typeof PRFilesReviewLayout> = {
  item,
  comments: [comment, { ...comment, id: 2, path: 'file.ts', body: 'Inline thread' }],
  participants: [],
  canComment: true,
  repoPath: '/workspace',
  repoId: 'repo-1',
  issueNumber: 7,
  itemType: 'pr',
  prRepo: { owner: 'example', repo: 'project' },
  onCommentAdded: vi.fn(),
  children: <div>Changed code</div>
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mutations.add.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Show the selected review with the same tooltip context as the application. */
function render(nextProps = props): void {
  act(() =>
    root.render(
      <TooltipProvider>
        <PRFilesReviewLayout {...nextProps} />
      </TooltipProvider>
    )
  )
}

/** Enter feedback through the controlled composer before exercising review changes. */
function writeDraft(body: string): HTMLTextAreaElement {
  const textarea = host.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      body
    )
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return textarea
}

describe('PR comments beside changed files', () => {
  it('keeps the draft while file contents and discussion refresh', () => {
    render()
    expect(host.textContent).toContain('Changed code')
    expect(host.textContent).toContain(comment.body)
    expect(host.textContent).not.toContain('Inline thread')
    const textarea = writeDraft('Check this change before merging.')
    render({ ...props, comments: [...props.comments], children: <div>Another changed file</div> })
    expect(host.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Check this change before merging.')
  })

  it('clears a draft when the review changes to another PR', () => {
    render()
    writeDraft('Comment for PR 7')
    render({ ...props, item: { ...item, number: 8, url: `${item.url}/other` }, issueNumber: 8 })
    expect(host.querySelector('textarea')?.value).toBe('')
  })

  it('retains a failed draft and routes retry to the same selected repository', async () => {
    render()
    writeDraft('Please preserve this behavior.')
    mutations.add.mockResolvedValueOnce({ ok: false, error: 'Try again.' })
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Send comment"]')!
    await act(async () => button.click())
    expect(host.querySelector('textarea')?.value).toBe('Please preserve this behavior.')
    mutations.add.mockResolvedValueOnce({ ok: true, comment })
    await act(async () => button.click())
    expect(mutations.add).toHaveBeenLastCalledWith({
      repoPath: '/workspace',
      repoId: 'repo-1',
      sourceContext: undefined,
      number: 7,
      body: 'Please preserve this behavior.',
      type: 'pr',
      prRepo: { owner: 'example', repo: 'project' }
    })
    expect(host.querySelector('textarea')?.value).toBe('')
    expect(props.onCommentAdded).toHaveBeenCalledWith(comment)
  })

  it('keeps discussion readable without enabling mutations for an unavailable target', () => {
    render({ ...props, repoPath: null })
    expect(host.textContent).toContain(comment.body)
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('supports a remote source without requiring a local checkout path', async () => {
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'github:example/project',
      hostId: 'runtime:remote-host' as const,
      repoId: 'remote-repo'
    }
    render({ ...props, repoPath: null, sourceContext })
    writeDraft('Remote review comment')
    mutations.add.mockResolvedValueOnce({ ok: true, comment })
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(mutations.add.mock.lastCall?.[0]).toMatchObject({
      repoPath: '',
      sourceContext,
      number: 7
    })
  })
})
