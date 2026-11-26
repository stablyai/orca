// @vitest-environment happy-dom

import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConversationCommentsList } from './comments-list'
import { ConversationDescription } from './description'
import { ConversationTab } from './tab'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { PRComment } from '../../../../../shared/github/comments/comment-types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Why: the tab's side panels read through window.api; reads stay pending and on* subscriptions return an unsubscribe.
function pendingBridge(): unknown {
  return new Proxy(() => {}, {
    get: (_target, key) =>
      typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => {} : pendingBridge(),
    apply: () => new Promise<never>(() => {})
  })
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('api', pendingBridge())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// Synthetic data only.
const item: GitHubWorkItem = {
  id: 'fixture-pr-12',
  type: 'pr',
  number: 12,
  title: 'Sample change',
  state: 'open',
  url: 'https://example.com/sample-org/sample-repo/pull/12',
  labels: [],
  updatedAt: '2026-01-05T09:00:00Z',
  author: 'sample-author',
  repoId: 'fixture-repo'
}

function renderComments(comments: PRComment[], loadingSkeleton: boolean): void {
  act(() =>
    root.render(
      <ConversationCommentsList
        itemType="pr"
        comments={comments}
        loadingSkeleton={loadingSkeleton}
        visibleComments={comments}
        visibleCommentGroups={[]}
        commentFilter="all"
        commentCounts={{ all: 0, humans: 0, bots: 0 }}
        repoPath="/fixture/sample-repo"
        repoId="fixture-repo"
        prNumber={12}
        prRepo={null}
        files={[]}
        headSha={undefined}
        baseSha={undefined}
        markdownGitHubRepo={null}
        mentionOptions={[]}
        resolvedReplyingTo={null}
        onFilterChange={() => {}}
        onToggleReply={() => {}}
        onSubmitReply={async () => true}
      />
    )
  )
}

function show(node: React.ReactNode): void {
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

function renderDescription({
  loading,
  detailsLoaded
}: {
  loading: boolean
  detailsLoaded: boolean
}): void {
  show(
    <ConversationDescription
      authorLabel="sample-author"
      updatedAt="2026-01-05T09:00:00Z"
      canEditBody
      loading={loading}
      detailsLoaded={detailsLoaded}
      bodyEditing={false}
      bodySaving={false}
      bodyChanged={false}
      body=""
      resolvedBodyDraft=""
      bodyTextareaRef={createRef<HTMLTextAreaElement>()}
      mentionOptions={[]}
      markdownGitHubRepo={null}
      onCancelEdit={() => {}}
      onStartEdit={() => {}}
      onSave={() => {}}
      onDraftChange={() => {}}
    />
  )
}

function renderTab({ loading, detailsLoaded }: { loading: boolean; detailsLoaded: boolean }) {
  show(
    <ConfirmationDialogProvider>
      <ConversationTab
        item={item}
        repoPath="/fixture/sample-repo"
        repoId="fixture-repo"
        body=""
        comments={[]}
        files={[]}
        headSha={undefined}
        baseSha={undefined}
        loading={loading}
        detailsLoaded={detailsLoaded}
        checks={[]}
        participants={[]}
        localState="open"
        onStateChange={() => {}}
        projectOrigin={undefined}
        onMutated={() => {}}
        onChecksUpdated={() => {}}
        onBodyUpdated={() => {}}
        onCommentAdded={() => {}}
        onReviewersRequested={() => {}}
      />
    </ConfirmationDialogProvider>
  )
}

describe('PR page conversation cold read', () => {
  it('shows comment skeletons instead of the empty copy before a read confirms it', () => {
    renderComments([], true)
    expect(container.textContent).not.toContain('No comments yet.')
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)

    renderComments([], false)
    expect(container.textContent).toContain('No comments yet.')
  })

  it('replaces the description spinner with lines and holds the edit button slot', () => {
    renderDescription({ loading: true, detailsLoaded: false })
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.textContent).not.toContain('No description provided.')
    expect(container.querySelector('span.ml-auto.size-7[aria-hidden="true"]')).not.toBeNull()

    renderDescription({ loading: false, detailsLoaded: true })
    expect(container.textContent).toContain('No description provided.')
    expect(container.querySelector('button[aria-label="Edit description"]')).not.toBeNull()
  })

  it('keeps a disabled composer in place while the details load', () => {
    renderTab({ loading: true, detailsLoaded: false })
    const placeholder = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Add a comment…"]'
    )
    expect(placeholder?.disabled).toBe(true)
    expect(container.textContent).toContain('Comments')
    expect(container.textContent).not.toContain('No comments yet.')
  })
})
