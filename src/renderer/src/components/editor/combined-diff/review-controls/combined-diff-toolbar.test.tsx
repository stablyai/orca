// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import { SELF_LOCAL_AUTHORITY } from '../../../../../../shared/host-authority'
import { CombinedDiffToolbar } from './combined-diff-toolbar'

vi.mock('@/store', async () => ({
  useAppStore: (await import('../../review-note-delivery/notes-send-menu-store.test-fixture'))
    .notesSendTestStore
}))
vi.mock('@/store/index', async () => ({
  useAppStore: (await import('../../review-note-delivery/notes-send-menu-store.test-fixture'))
    .notesSendTestStore
}))
vi.mock('@/store/retained-views/app-state-view', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAppStateValue: (await import('../../review-note-delivery/notes-send-menu-store.test-fixture'))
    .useNotesSendTestStateValue
}))

const WT = 'repo::/wt'
const OWNER: DiffCommentOwner = {
  kind: 'worktree',
  worktreeId: WT,
  authority: SELF_LOCAL_AUTHORITY
}
const FILE: OpenFile = {
  id: 'combined',
  filePath: '/wt',
  relativePath: '',
  worktreeId: WT,
  language: 'plaintext',
  isDirty: false,
  mode: 'diff'
}
const NOTE: DiffComment = {
  id: 'n1',
  worktreeId: WT,
  filePath: 'src/a.ts',
  lineNumber: 4,
  body: 'Keep the boolean',
  createdAt: 1,
  side: 'modified'
}

function renderToolbar(comments: DiffComment[]): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <CombinedDiffToolbar
        activeGroupId={undefined}
        allSectionsCollapsed={false}
        branchCompare={null}
        commitCompare={null}
        commentOwner={OWNER}
        diffCommentsForWorktree={comments}
        diffShowWhitespace={false}
        diffWordWrap={false}
        file={FILE}
        fileTreeCollapsed={false}
        isAllMode={false}
        isBranchMode={false}
        isCommitMode={false}
        onOpenAlternateDiff={() => undefined}
        onShowFileTree={() => undefined}
        sectionCount={16}
        setAllSectionsCollapsed={() => undefined}
        sideBySide={false}
        toggleDiffShowWhitespace={() => undefined}
        toggleDiffWordWrap={() => undefined}
        toggleSideBySide={() => undefined}
      />
    </TooltipProvider>
  )
}

function viewControls(): HTMLElement {
  const sideBySide = screen.getByRole('button', { name: 'Side by Side' })
  return sideBySide.parentElement!
}

afterEach(cleanup)

describe('CombinedDiffToolbar send button', () => {
  it('appears after the file count without adding anything to the view controls', () => {
    renderToolbar([])
    expect(screen.queryByRole('button', { name: /Send .* to an agent/ })).toBeNull()
    const controlsWithoutNotes = within(viewControls())
      .getAllByRole('button')
      .map((button) => button.textContent)
    cleanup()

    renderToolbar([NOTE])
    const send = screen.getByRole('button', { name: 'Send 1 note to an agent' })
    const controlsWithNote = within(viewControls())
      .getAllByRole('button')
      .map((button) => button.textContent)

    expect(controlsWithNote).toEqual(controlsWithoutNotes)
    expect(viewControls()).not.toContainElement(send)
    const fileCount = screen.getByText('16 changed files')
    expect(fileCount.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
