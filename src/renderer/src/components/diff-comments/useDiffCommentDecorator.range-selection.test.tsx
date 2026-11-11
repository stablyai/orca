// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Selection } from 'monaco-editor'
import type * as DiffCommentZoneCardModule from './diff-comment-zone-card'
import type { NotesSendMenu } from '../editor/review-note-delivery/NotesSendMenu'

vi.mock('monaco-editor', () => import('monaco-editor/esm/vs/editor/editor.api.js'))

const notesMenuFixture = vi.hoisted(() => ({
  NotesSendMenu: vi.fn<typeof NotesSendMenu>(() => {
    throw new Error('Range selection must not render the agent notes menu')
  })
}))

vi.mock('../editor/review-note-delivery/NotesSendMenu', () => ({
  NotesSendMenu: notesMenuFixture.NotesSendMenu
}))

const storeFixture = vi.hoisted(() => ({
  activeGroupIdByWorktree: {},
  clearDeliveredDiffComments: vi.fn(),
  keybindings: undefined
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeFixture) => unknown) => selector(storeFixture),
    { getState: () => storeFixture }
  )
}))

vi.mock('./diff-comment-zone-card', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffCommentZoneCardModule>()),
  renderDiffCommentZoneCard: vi.fn()
}))

import { useDiffCommentDecorator } from './useDiffCommentDecorator'
import {
  createFakeDiffCommentEditor,
  type FakeDiffCommentEditor
} from './diff-comment-editor-test-fixture'
import type { DiffCommentLineTarget } from './diff-comment-line-range'

const FILE_PATH = 'src/index.ts'
const WORKTREE_ID = 'worktree-1'

type DecoratorProps = {
  pendingCommentTarget?: DiffCommentLineTarget | null
  commentableLineNumbers?: readonly number[]
  addNoteShortcutEnabled?: boolean
  onAddCommentClick?: (args: { lineNumber: number; startLine?: number; top: number }) => void
  // Present on the inline-draft surfaces; absent for the legacy popover callers.
  onCreateComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
}

function renderDecorator(fake: FakeDiffCommentEditor, initialProps: DecoratorProps = {}) {
  return renderHook(
    (props: DecoratorProps) =>
      useDiffCommentDecorator({
        editor: fake.editor,
        filePath: FILE_PATH,
        worktreeId: WORKTREE_ID,
        comments: [],
        commentableLineNumbers: props.commentableLineNumbers,
        pendingCommentTarget: props.pendingCommentTarget ?? null,
        addNoteShortcutEnabled: props.addNoteShortcutEnabled ?? false,
        onAddCommentClick: props.onAddCommentClick ?? vi.fn(),
        onCreateComment: props.onCreateComment,
        onDeleteComment: vi.fn()
      }),
    { initialProps }
  )
}

// Monaco exposes drag direction separately from sorted bounds; the double needs only the fields the shortcut reads.
function selectionOf(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
  anchor: 'start' | 'end' = 'start'
): Selection {
  const selectionStartLineNumber = anchor === 'start' ? startLineNumber : endLineNumber
  const positionLineNumber = anchor === 'start' ? endLineNumber : startLineNumber
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveDiffCommentShortcutTarget reads only these six fields.
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    selectionStartLineNumber,
    positionLineNumber
  } as Selection
}

function pressAddReviewNoteChord(node: HTMLElement): KeyboardEvent {
  const isMac = navigator.userAgent.includes('Mac')
  const event = new KeyboardEvent('keydown', {
    key: 'A',
    code: 'KeyA',
    shiftKey: true,
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    cancelable: true
  })
  node.dispatchEvent(event)
  return event
}

const frameCallbacks: FrameRequestCallback[] = []

beforeEach(() => {
  frameCallbacks.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameCallbacks.push(callback)
    return frameCallbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frameCallbacks.length = 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  try {
    expect(notesMenuFixture.NotesSendMenu).not.toHaveBeenCalled()
  } finally {
    vi.clearAllMocks()
  }
})

describe('useDiffCommentDecorator add-note chord', () => {
  it('leaves the chord to an open inline draft card instead of re-anchoring it', () => {
    const fake = createFakeDiffCommentEditor()
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(9, 1, 14, 8))
    renderDecorator(fake, {
      addNoteShortcutEnabled: true,
      onCreateComment: vi.fn().mockResolvedValue(true)
    })

    act(() => {
      pressAddReviewNoteChord(fake.domNode)
    })
    const [zone] = [...fake.zones.values()]
    expect(zone?.afterLineNumber).toBe(14)

    // Later editor selection changes must not move an open card or its text.
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(30, 1, 32, 4))
    const secondChord: { event?: KeyboardEvent } = {}
    act(() => {
      secondChord.event = pressAddReviewNoteChord(fake.domNode)
    })

    expect(secondChord.event?.defaultPrevented).toBe(true)
    expect([...fake.zones.values()]).toEqual([zone])
  })
})
