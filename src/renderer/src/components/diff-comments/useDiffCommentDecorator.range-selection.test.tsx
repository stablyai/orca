// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Selection } from 'monaco-editor'
import type * as DiffCommentZoneCardModule from './diff-comment-zone-card'

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
        onDeleteComment: vi.fn()
      }),
    { initialProps }
  )
}

// Monaco's Selection carries a large method surface the shortcut never touches, so the double is
// built once here rather than cast at each call site. `anchor` names the end the user dragged
// from, which Monaco reports separately from the sorted bounds.
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

function paintedRange(fake: FakeDiffCommentEditor): { startLine: number; endLine: number } | null {
  const [decoration] = fake.decorations()
  return decoration ? { startLine: decoration.startLine, endLine: decoration.endLine } : null
}

function firePointerEvent(
  node: EventTarget,
  type: string,
  init: { clientX: number; clientY: number }
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    ...init,
    button: 0,
    pointerType: 'mouse',
    pointerId: 1,
    ctrlKey: false
  })
  node.dispatchEvent(event)
}

// Mod+Shift+A on the platform this test's user agent reports.
function pressAddReviewNoteChord(node: HTMLElement): void {
  const isMac = navigator.userAgent.includes('Mac')
  node.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'A',
      code: 'KeyA',
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true
    })
  )
}

const frameCallbacks: FrameRequestCallback[] = []

function pumpFrame(): void {
  for (const callback of frameCallbacks.splice(0)) {
    callback(16)
  }
}

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
  vi.clearAllMocks()
})

describe('useDiffCommentDecorator range highlight', () => {
  it('keeps the open composer range lit and clears it when the composer closes', () => {
    const fake = createFakeDiffCommentEditor()
    const hook = renderDecorator(fake)
    expect(paintedRange(fake)).toBeNull()

    hook.rerender({ pendingCommentTarget: { lineNumber: 14, startLine: 9 } })
    expect(paintedRange(fake)).toEqual({ startLine: 9, endLine: 14 })
    expect(fake.decorations()[0].className).toBe('orca-diff-comment-range-highlight')

    hook.rerender({ pendingCommentTarget: null })
    expect(paintedRange(fake)).toBeNull()
  })

  it('lights the single line of a single-line composer', () => {
    const fake = createFakeDiffCommentEditor()
    const hook = renderDecorator(fake)

    hook.rerender({ pendingCommentTarget: { lineNumber: 14 } })

    expect(paintedRange(fake)).toEqual({ startLine: 14, endLine: 14 })
  })

  it('does not rewrite the decoration while the composer only moves with the scroll', () => {
    const fake = createFakeDiffCommentEditor()
    const hook = renderDecorator(fake, {
      pendingCommentTarget: { lineNumber: 14, startLine: 9 }
    })
    const writes = fake.decorationWrites()

    // A scroll rewrites the composer's `top` and hands down a fresh object every frame.
    for (let frame = 0; frame < 20; frame += 1) {
      hook.rerender({ pendingCommentTarget: { lineNumber: 14, startLine: 9 } })
    }

    expect(fake.decorationWrites()).toBe(writes)
  })

  it('re-lights the composer range after the overlay is rebuilt under it', () => {
    const fake = createFakeDiffCommentEditor()
    const hook = renderDecorator(fake, {
      pendingCommentTarget: { lineNumber: 14, startLine: 9 },
      commentableLineNumbers: [9, 10, 11, 12, 13, 14]
    })
    expect(paintedRange(fake)).toEqual({ startLine: 9, endLine: 14 })

    // A review refresh that really widens the patch rebuilds the overlay.
    hook.rerender({
      pendingCommentTarget: { lineNumber: 14, startLine: 9 },
      commentableLineNumbers: [9, 10, 11, 12, 13, 14, 15, 16]
    })

    expect(paintedRange(fake)).toEqual({ startLine: 9, endLine: 14 })
  })
})

describe('useDiffCommentDecorator drag affordance', () => {
  it('rides the "+" down to the growing end of the selection', () => {
    const fake = createFakeDiffCommentEditor()
    renderDecorator(fake)
    const plus = fake.domNode.querySelector<HTMLElement>('.orca-diff-comment-add-btn')
    expect(plus, 'add button was never mounted').not.toBeNull()

    fake.emitMouseMove(5)
    const parkedTop = plus!.style.top

    // Press the button itself, then drag down the same column.
    firePointerEvent(plus!, 'pointerdown', {
      clientX: 8,
      clientY: fake.clientYForLine(5)
    })
    firePointerEvent(document, 'pointermove', {
      clientX: 8,
      clientY: fake.clientYForLine(11)
    })
    pumpFrame()

    expect(plus!.style.top, 'the "+" did not follow the drag').not.toBe(parkedTop)
    expect(plus!.style.pointerEvents, 'the "+" must not block its own hit-test').toBe('none')
    expect(fake.decorations()[0]).toMatchObject({ startLine: 5, endLine: 11 })

    firePointerEvent(document, 'pointerup', {
      clientX: 8,
      clientY: fake.clientYForLine(11)
    })
    expect(plus!.style.pointerEvents).toBe('')
  })
})

describe('useDiffCommentDecorator add-note chord', () => {
  it('opens a ranged composer from the editor selection', () => {
    const fake = createFakeDiffCommentEditor()
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(9, 1, 14, 8))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, { addNoteShortcutEnabled: true, onAddCommentClick })

    pressAddReviewNoteChord(fake.domNode)

    expect(onAddCommentClick).toHaveBeenCalledWith(
      expect.objectContaining({ lineNumber: 14, startLine: 9 })
    )
  })

  it('opens a single-line composer from a bare cursor', () => {
    const fake = createFakeDiffCommentEditor()
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(9, 3, 9, 3))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, { addNoteShortcutEnabled: true, onAddCommentClick })

    pressAddReviewNoteChord(fake.domNode)

    expect(onAddCommentClick).toHaveBeenCalledWith(
      expect.objectContaining({ lineNumber: 9, startLine: undefined })
    )
  })

  it('clamps a selection that runs past the end of the hunk', () => {
    const fake = createFakeDiffCommentEditor()
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(9, 1, 30, 4))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, {
      addNoteShortcutEnabled: true,
      commentableLineNumbers: [9, 10, 11, 12],
      onAddCommentClick
    })

    pressAddReviewNoteChord(fake.domNode)

    expect(onAddCommentClick).toHaveBeenCalledWith(
      expect.objectContaining({ lineNumber: 12, startLine: 9 })
    )
  })

  it('leaves the chord alone on a surface that never binds it', () => {
    const fake = createFakeDiffCommentEditor()
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, { addNoteShortcutEnabled: false, onAddCommentClick })

    pressAddReviewNoteChord(fake.domNode)

    expect(onAddCommentClick).not.toHaveBeenCalled()
  })

  it('clamps an upward selection from its anchor, not the hunk above it', () => {
    const fake = createFakeDiffCommentEditor()
    // Anchored at 41 in the lower hunk, extended up to 12 in the upper one.
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(12, 2, 41, 6, 'end'))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, {
      addNoteShortcutEnabled: true,
      commentableLineNumbers: [10, 11, 12, 13, 14, 15, 16, 40, 41, 42],
      onAddCommentClick
    })

    pressAddReviewNoteChord(fake.domNode)

    expect(onAddCommentClick).toHaveBeenCalledWith(
      expect.objectContaining({ lineNumber: 41, startLine: 40 })
    )
  })

  it('leaves the chord unconsumed when the selection is outside the commentable lines', () => {
    const fake = createFakeDiffCommentEditor()
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(40, 1, 41, 4))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, {
      addNoteShortcutEnabled: true,
      commentableLineNumbers: [9, 10, 11, 12],
      onAddCommentClick
    })

    const event = new KeyboardEvent('keydown', {
      key: 'A',
      code: 'KeyA',
      shiftKey: true,
      metaKey: navigator.userAgent.includes('Mac'),
      ctrlKey: !navigator.userAgent.includes('Mac'),
      bubbles: true,
      cancelable: true
    })
    fake.domNode.dispatchEvent(event)

    expect(onAddCommentClick).not.toHaveBeenCalled()
    // Unconsumed, so whatever else the user bound the chord to still gets it.
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves the chord to the composer once one is open', () => {
    const fake = createFakeDiffCommentEditor()
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(9, 1, 14, 8))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, {
      addNoteShortcutEnabled: true,
      pendingCommentTarget: { lineNumber: 14, startLine: 9 },
      onAddCommentClick
    })

    pressAddReviewNoteChord(fake.domNode)

    expect(onAddCommentClick).not.toHaveBeenCalled()
  })

  it('stands aside while a gutter drag still owns the band', () => {
    const fake = createFakeDiffCommentEditor()
    // The pre-drag selection the chord would otherwise open a composer on.
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(30, 1, 32, 4))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, { addNoteShortcutEnabled: true, onAddCommentClick })

    firePointerEvent(fake.domNode, 'pointerdown', { clientX: 30, clientY: fake.clientYForLine(5) })
    firePointerEvent(document, 'pointermove', { clientX: 30, clientY: fake.clientYForLine(11) })
    pumpFrame()

    pressAddReviewNoteChord(fake.domNode)
    expect(onAddCommentClick).not.toHaveBeenCalled()

    // Release still commits the swept range, and only that range.
    firePointerEvent(document, 'pointerup', { clientX: 30, clientY: fake.clientYForLine(11) })
    expect(onAddCommentClick).toHaveBeenCalledTimes(1)
    expect(onAddCommentClick).toHaveBeenCalledWith(
      expect.objectContaining({ lineNumber: 11, startLine: 5 })
    )
  })

  it('claims the chord synchronously so a same-turn repeat cannot reopen the draft', () => {
    const fake = createFakeDiffCommentEditor()
    vi.spyOn(fake.editor, 'getSelection').mockReturnValue(selectionOf(9, 1, 14, 8))
    const onAddCommentClick = vi.fn()
    renderDecorator(fake, { addNoteShortcutEnabled: true, onAddCommentClick })

    pressAddReviewNoteChord(fake.domNode)
    pressAddReviewNoteChord(fake.domNode)

    expect(onAddCommentClick).toHaveBeenCalledTimes(1)
  })
})
