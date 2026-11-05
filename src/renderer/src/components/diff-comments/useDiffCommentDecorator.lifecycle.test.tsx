// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecoratedDiffComment } from './decorated-diff-comment'
import type * as ReactDomClientModule from 'react-dom/client'
import type * as DiffCommentZoneCardModule from './diff-comment-zone-card'
import type { NotesSendMenu } from '../editor/review-note-delivery/NotesSendMenu'

vi.mock('monaco-editor', () => import('monaco-editor/esm/vs/editor/editor.api.js'))

const notesMenuFixture = vi.hoisted(() => ({
  NotesSendMenu: vi.fn<typeof NotesSendMenu>(() => {
    throw new Error('Commentable-line lifecycle must not render the agent notes menu')
  })
}))

vi.mock('../editor/review-note-delivery/NotesSendMenu', () => ({
  NotesSendMenu: notesMenuFixture.NotesSendMenu
}))

const storeFixture = vi.hoisted(() => ({
  activeGroupIdByWorktree: {},
  clearDeliveredDiffComments: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture)
}))

// Stub card rendering to isolate zone/root lifecycles.
vi.mock('./diff-comment-zone-card', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffCommentZoneCardModule>()),
  renderDiffCommentZoneCard: vi.fn()
}))

const rootCounts = vi.hoisted(() => ({ created: 0, unmounted: 0 }))

// Count only roots the decorator creates for its zones — @testing-library/react creates its own.
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactDomClientModule>()
  return {
    ...actual,
    createRoot: (container: Element, options?: Parameters<typeof actual.createRoot>[1]) => {
      const isZoneRoot = container.classList?.contains('orca-diff-comment-inline') ?? false
      if (isZoneRoot) {
        rootCounts.created += 1
      }
      const root = actual.createRoot(container, options)
      return {
        render: (node: Parameters<typeof root.render>[0]) => root.render(node),
        unmount: () => {
          if (isZoneRoot) {
            rootCounts.unmounted += 1
          }
          root.unmount()
        }
      }
    }
  }
})

import { useDiffCommentDecorator } from './useDiffCommentDecorator'
import { createFakeDiffCommentEditor } from './diff-comment-editor-test-fixture'

const FILE_PATH = 'src/index.ts'
const REVIEW_SURFACE_ID = 'pr:acme/widgets:42'

function reviewNote(index: number): DecoratedDiffComment {
  return {
    id: `review-note-${index}`,
    worktreeId: REVIEW_SURFACE_ID,
    filePath: FILE_PATH,
    lineNumber: 10 + index,
    body: `Please rename this (${index}).`,
    createdAt: index,
    side: 'modified',
    author: 'octocat'
  }
}

// Remote review refreshes replace arrays even when their values match.
function freshCommentableLines(): readonly number[] {
  return [10, 11, 12, 13, 14, 15, 16]
}

// Drain deferred root unmounts before reading counts.
async function flushDeferredUnmounts(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  rootCounts.created = 0
  rootCounts.unmounted = 0
})

afterEach(async () => {
  cleanup()
  await flushDeferredUnmounts()
  document.body.replaceChildren()
  try {
    expect(notesMenuFixture.NotesSendMenu).not.toHaveBeenCalled()
  } finally {
    vi.clearAllMocks()
  }
})

describe('useDiffCommentDecorator commentable-line churn', () => {
  it('removes its zones from Monaco when the model swaps under a retained editor', async () => {
    const fake = createFakeDiffCommentEditor()
    const comments = [reviewNote(1)]
    const hook = renderHook(
      ({ monacoModelIdentity }) =>
        useDiffCommentDecorator({
          editor: fake.editor,
          monacoModelIdentity,
          filePath: FILE_PATH,
          worktreeId: REVIEW_SURFACE_ID,
          comments,
          commentableLineNumbers: freshCommentableLines(),
          onAddCommentClick: vi.fn(),
          onDeleteComment: vi.fn()
        }),
      { initialProps: { monacoModelIdentity: 'modified-v1' } }
    )
    const firstZoneIds = [...fake.zones.keys()]

    hook.rerender({ monacoModelIdentity: 'modified-v2' })
    await flushDeferredUnmounts()

    expect(fake.zones.size).toBe(1)
    expect([...fake.zones.keys()]).not.toEqual(firstZoneIds)
    expect(rootCounts.created).toBe(2)
    expect(rootCounts.unmounted).toBe(1)
  })
})

/** No zones exist in the overlay disposal case, so the hook never reaches these. */
