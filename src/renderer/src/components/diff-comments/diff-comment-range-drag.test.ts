// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeDiffCommentEditor,
  FAKE_EDITOR_HEIGHT_PX,
  FAKE_EDITOR_TOP_PX,
  type FakeDiffCommentEditor
} from './diff-comment-editor-test-fixture'
import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import { getGutterPressLine, installDiffCommentRangeDrag } from './diff-comment-range-drag'
import type { DiffCommentLineRange } from './diff-comment-line-range'

// Frames are pumped by hand so "one hit-test per frame, whatever the OS delivered" is an
// assertion rather than a hope.
const frameCallbacks: FrameRequestCallback[] = []
let nextFrameHandle = 0
let frameTimestampMs = 0

function pumpFrame(advanceMs = 16): void {
  frameTimestampMs += advanceMs
  const pending = frameCallbacks.splice(0)
  for (const callback of pending) {
    callback(frameTimestampMs)
  }
}

function pendingFrameCount(): number {
  return frameCallbacks.length
}

beforeEach(() => {
  frameCallbacks.length = 0
  nextFrameHandle = 0
  frameTimestampMs = 0
  lastPointerClientY = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameCallbacks.push(callback)
    return (nextFrameHandle += 1)
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frameCallbacks.length = 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

type PointerEventInit = {
  clientY: number
  clientX?: number
  button?: number
  pointerType?: string
  target?: EventTarget
}

// The position the last dispatched pointer event carried, so a release lands where the pointer
// actually is — the browser puts real coordinates on pointerup too.
let lastPointerClientY = 0

// happy-dom has no PointerEvent constructor, so the fields the controller reads are grafted on.
function firePointerEvent(
  node: EventTarget,
  type: string,
  { clientY, clientX = 30, button = 0, pointerType = 'mouse' }: PointerEventInit
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX, clientY, button, pointerType, pointerId: 1, ctrlKey: false })
  lastPointerClientY = clientY
  node.dispatchEvent(event)
  return event
}

type DragHarness = {
  fake: FakeDiffCommentEditor
  commits: DiffCommentLineRange[]
  dragStates: boolean[]
  focusLines: (number | null)[]
  handle: ReturnType<typeof installDiffCommentRangeDrag>
  pressLine: (lineNumber: number, init?: Partial<PointerEventInit>) => void
  moveToLine: (lineNumber: number) => void
  /** Releases where the pointer was left, or on an explicit line the moves never reported. */
  release: (lineNumber?: number) => void
}

function mountDrag(
  options: {
    commentableLineSet?: ReadonlySet<number> | null
    resolvePressLine?: (event: PointerEvent) => number | null
    unresolvableLines?: readonly number[]
    deadColumn?: { fromX: number; toX: number }
    gutterTargetType?: monacoEditor.MouseTargetType
  } = {}
): DragHarness {
  const fake = createFakeDiffCommentEditor({
    unresolvableLines: options.unresolvableLines,
    deadColumn: options.deadColumn,
    gutterTargetType: options.gutterTargetType
  })
  const commits: DiffCommentLineRange[] = []
  const dragStates: boolean[] = []
  const focusLines: (number | null)[] = []
  const handle = installDiffCommentRangeDrag({
    editor: fake.editor,
    editorDomNode: fake.domNode,
    commentableLineSet: options.commentableLineSet ?? null,
    resolvePressLine:
      options.resolvePressLine ?? ((event) => getGutterPressLine(fake.editor, event)),
    onDragChange: ({ dragging, focusLine }) => {
      dragStates.push(dragging)
      focusLines.push(focusLine)
    },
    onCommit: (range) => commits.push(range)
  })
  return {
    fake,
    commits,
    dragStates,
    focusLines,
    handle,
    pressLine: (lineNumber, init = {}) =>
      firePointerEvent(fake.domNode, 'pointerdown', {
        clientY: fake.clientYForLine(lineNumber),
        ...init
      }),
    moveToLine: (lineNumber) =>
      firePointerEvent(document, 'pointermove', { clientY: fake.clientYForLine(lineNumber) }),
    release: (lineNumber) => {
      firePointerEvent(document, 'pointerup', {
        clientY: lineNumber === undefined ? lastPointerClientY : fake.clientYForLine(lineNumber)
      })
    }
  }
}

function paintedRange(fake: FakeDiffCommentEditor): DiffCommentLineRange | null {
  const [decoration] = fake.decorations()
  return decoration ? { startLine: decoration.startLine, endLine: decoration.endLine } : null
}

describe('diff comment gutter range drag', () => {
  it('commits the swept range and lights it while the pointer is down', () => {
    const drag = mountDrag()

    drag.pressLine(12)
    expect(paintedRange(drag.fake)).toEqual({ startLine: 12, endLine: 12 })

    drag.moveToLine(17)
    pumpFrame()
    expect(paintedRange(drag.fake)).toEqual({ startLine: 12, endLine: 17 })

    drag.release()
    expect(drag.commits).toEqual([{ startLine: 12, endLine: 17 }])
    // The focus stream is what moves the "+" to the growing end of the selection.
    expect(drag.dragStates).toEqual([true, true, false])
    expect(drag.focusLines).toEqual([12, 17, null])
    drag.handle.dispose()
  })

  it('commits a single line when the pointer never moves, exactly like a click', () => {
    const drag = mountDrag()

    drag.pressLine(12)
    drag.release()

    expect(drag.commits).toEqual([{ startLine: 12, endLine: 12 }])
    drag.handle.dispose()
  })

  it('resolves the latest pointer position when release beats the animation frame', () => {
    const drag = mountDrag()

    drag.pressLine(12)
    drag.moveToLine(17)
    drag.release()

    expect(drag.commits).toEqual([{ startLine: 12, endLine: 17 }])
    drag.handle.dispose()
  })

  it('commits the line the release landed on when no pointermove reported it', () => {
    const drag = mountDrag()

    drag.pressLine(12)
    // A press, then a release several lines down with nothing in between: the browser can deliver
    // pointerup at a position no pointermove ever carried.
    drag.release(17)

    expect(drag.commits).toEqual([{ startLine: 12, endLine: 17 }])
    drag.handle.dispose()
  })

  it('orders a range dragged upward', () => {
    const drag = mountDrag()

    drag.pressLine(20)
    drag.moveToLine(14)
    pumpFrame()
    drag.release()

    expect(drag.commits).toEqual([{ startLine: 14, endLine: 20 }])
    drag.handle.dispose()
  })

  it('clamps at a hunk edge instead of jumping the gap', () => {
    const drag = mountDrag({ commentableLineSet: new Set([10, 11, 12, 13, 14, 40, 41]) })

    drag.pressLine(11)
    drag.moveToLine(41)
    pumpFrame()

    expect(paintedRange(drag.fake)).toEqual({ startLine: 11, endLine: 14 })
    drag.release()
    expect(drag.commits).toEqual([{ startLine: 11, endLine: 14 }])
    drag.handle.dispose()
  })

  it('ignores a press on a line that cannot take a comment', () => {
    const drag = mountDrag({ commentableLineSet: new Set([10, 11, 12]) })

    drag.pressLine(30)
    drag.release()

    expect(drag.commits).toEqual([])
    expect(paintedRange(drag.fake)).toBeNull()
    drag.handle.dispose()
  })

  it('ignores non-primary buttons and touch so the context menu and pane scrolling survive', () => {
    const drag = mountDrag()

    drag.pressLine(12, { button: 2 })
    drag.pressLine(12, { pointerType: 'touch' })
    drag.release()

    expect(drag.commits).toEqual([])
    expect(drag.dragStates).toEqual([])
    drag.handle.dispose()
  })

  it('takes the press away from Monaco only when it is ours', () => {
    const drag = mountDrag({ commentableLineSet: new Set([10, 11, 12]) })
    const ours = firePointerEvent(drag.fake.domNode, 'pointerdown', {
      clientY: drag.fake.clientYForLine(11)
    })
    expect(ours.defaultPrevented).toBe(true)
    drag.release()

    const theirs = firePointerEvent(drag.fake.domNode, 'pointerdown', {
      clientY: drag.fake.clientYForLine(50)
    })
    expect(theirs.defaultPrevented).toBe(false)
    drag.handle.dispose()
  })

  it('abandons the range on Escape, on pointercancel and when the editor goes away', () => {
    for (const abort of [
      (drag: DragHarness) =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) &&
        drag,
      () => firePointerEvent(document, 'pointercancel', { clientY: 0 }),
      (drag: DragHarness) => drag.fake.emitDispose()
    ]) {
      const drag = mountDrag()
      drag.pressLine(12)
      drag.moveToLine(18)
      pumpFrame()
      expect(paintedRange(drag.fake)).toEqual({ startLine: 12, endLine: 18 })

      abort(drag)

      expect(paintedRange(drag.fake)).toBeNull()
      drag.release()
      expect(drag.commits).toEqual([])
      drag.handle.dispose()
    }
  })

  it('keeps the composer range lit after the pointer is gone, and clears with the composer', () => {
    const drag = mountDrag()

    drag.pressLine(12)
    drag.moveToLine(15)
    pumpFrame()
    drag.release()
    // The composer opens with the committed range, as the decorator wires it.
    drag.handle.setPendingRange({ startLine: 12, endLine: 15 })
    expect(paintedRange(drag.fake)).toEqual({ startLine: 12, endLine: 15 })

    drag.handle.setPendingRange(null)
    expect(paintedRange(drag.fake)).toBeNull()
    drag.handle.dispose()
  })

  it('refuses a new press while a composer owns the highlight', () => {
    const drag = mountDrag()
    drag.handle.setPendingRange({ startLine: 3, endLine: 5 })

    drag.pressLine(12)
    drag.moveToLine(20)
    pumpFrame()
    drag.release()

    expect(drag.commits).toEqual([])
    expect(paintedRange(drag.fake)).toEqual({ startLine: 3, endLine: 5 })
    drag.handle.dispose()
  })

  // The bug this replaces: the range was hit-tested under the pointer, and Monaco reports no
  // position for a point over the overlay's own "+" button, so every move was discarded and a
  // drag collapsed back to a single-line note.
  it('extends even while the pointer sits in a column Monaco will not resolve', () => {
    // Exactly the real gesture: press the "+" (a node Monaco does not own) and drag down its column.
    const drag = mountDrag({ deadColumn: { fromX: 0, toX: 60 }, resolvePressLine: () => 5 })

    firePointerEvent(drag.fake.domNode, 'pointerdown', {
      clientX: 30,
      clientY: drag.fake.clientYForLine(5)
    })
    firePointerEvent(document, 'pointermove', {
      clientX: 30,
      clientY: drag.fake.clientYForLine(11)
    })
    pumpFrame()

    expect(paintedRange(drag.fake)).toEqual({ startLine: 5, endLine: 11 })
    drag.release()
    expect(drag.commits).toEqual([{ startLine: 5, endLine: 11 }])
    drag.handle.dispose()
  })

  it('resolves a press on the "+" button through the line it is parked on', () => {
    const plus = document.createElement('button')
    document.body.appendChild(plus)
    const drag = mountDrag({ resolvePressLine: () => 7 })

    // A press on the button has no gutter target; the overlay supplies the hovered line.
    firePointerEvent(drag.fake.domNode, 'pointerdown', { clientY: 0 })
    drag.moveToLine(9)
    pumpFrame()
    drag.release()

    expect(drag.commits).toEqual([{ startLine: 7, endLine: 9 }])
    drag.handle.dispose()
  })

  // Keyboard paths read this to stand aside; the drag range isn't committed until release.
  it('reports the drag as owning the band from press to release', () => {
    const drag = mountDrag()
    expect(drag.handle.isDragging()).toBe(false)

    drag.pressLine(12)
    expect(drag.handle.isDragging()).toBe(true)
    drag.moveToLine(17)
    pumpFrame()
    expect(drag.handle.isDragging()).toBe(true)

    drag.release()
    expect(drag.handle.isDragging()).toBe(false)
    drag.handle.dispose()
  })
})

describe('diff comment gutter range drag target types', () => {
  // Monaco's folding controller toggles chevrons from its own mousedown on GUTTER_LINE_DECORATIONS,
  // and the markdown annotations editor installs this drag with no commentable-line set — so
  // claiming anything but the line numbers would eat the fold press on every line there.
  function pressGutter(drag: DragHarness): Event {
    return firePointerEvent(drag.fake.domNode, 'pointerdown', {
      clientY: drag.fake.clientYForLine(11)
    })
  }

  it('takes a press on the line numbers', () => {
    const drag = mountDrag({
      gutterTargetType: monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    })

    expect(pressGutter(drag).defaultPrevented).toBe(true)
    drag.release()

    expect(drag.commits).toEqual([{ startLine: 11, endLine: 11 }])
    drag.handle.dispose()
  })

  it('leaves the rest of the gutter to Monaco', () => {
    for (const type of [
      monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
      monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
    ]) {
      const drag = mountDrag({ gutterTargetType: type })

      expect(pressGutter(drag).defaultPrevented).toBe(false)
      drag.release()

      expect(drag.commits).toEqual([])
      expect(paintedRange(drag.fake)).toBeNull()
      drag.handle.dispose()
    }
  })
})

describe('diff comment gutter range drag performance', () => {
  it('collapses a burst of pointer moves into a single hit-test and decoration write', () => {
    const drag = mountDrag()
    const hitTest = vi.spyOn(drag.fake.editor, 'getTargetAtClientPoint')

    drag.pressLine(2)
    const writesAfterPress = drag.fake.decorationWrites()
    hitTest.mockClear()
    // Every line here is on screen, so the burst is measured without auto-scroll in the way.
    for (let line = 3; line <= 19; line += 1) {
      drag.moveToLine(line)
    }
    expect(pendingFrameCount()).toBe(1)
    pumpFrame()

    expect(hitTest).toHaveBeenCalledTimes(1)
    expect(drag.fake.decorationWrites() - writesAfterPress).toBe(1)
    expect(paintedRange(drag.fake)).toEqual({ startLine: 2, endLine: 19 })
    drag.handle.dispose()
  })

  it('does not rewrite the decoration when the resolved line has not changed', () => {
    const drag = mountDrag()

    drag.pressLine(12)
    drag.moveToLine(16)
    pumpFrame()
    const writes = drag.fake.decorationWrites()
    drag.moveToLine(16)
    pumpFrame()

    expect(drag.fake.decorationWrites()).toBe(writes)
    drag.handle.dispose()
  })

  it('schedules no frames while a held pointer rests away from the edges', () => {
    const drag = mountDrag()

    drag.pressLine(12)
    drag.moveToLine(16)
    pumpFrame()

    expect(pendingFrameCount()).toBe(0)
    drag.handle.dispose()
  })
})

describe('diff comment gutter range drag auto-scroll', () => {
  it('keeps scrolling and extending while the pointer is held past the bottom edge', () => {
    const drag = mountDrag()

    drag.pressLine(2)
    firePointerEvent(document, 'pointermove', {
      clientY: FAKE_EDITOR_TOP_PX + FAKE_EDITOR_HEIGHT_PX + 40
    })
    pumpFrame()
    const firstScrollTop = drag.fake.scrollTop()
    expect(firstScrollTop).toBeGreaterThan(0)
    // The pull continues without another pointer event.
    expect(pendingFrameCount()).toBe(1)
    pumpFrame()
    expect(drag.fake.scrollTop()).toBeGreaterThan(firstScrollTop)

    drag.release()
    expect(drag.commits[0].startLine).toBe(2)
    expect(drag.commits[0].endLine).toBeGreaterThan(2)
    drag.handle.dispose()
  })

  it('scrolls the same distance per millisecond on a 120Hz display as on a 60Hz one', () => {
    const belowBottom = FAKE_EDITOR_TOP_PX + FAKE_EDITOR_HEIGHT_PX + 40
    const scrollAfterFrames = (frameMs: number, frames: number): number => {
      const drag = mountDrag()
      drag.pressLine(2)
      firePointerEvent(document, 'pointermove', { clientY: belowBottom })
      // The first frame has no previous timestamp to measure against.
      pumpFrame(frameMs)
      const baseline = drag.fake.scrollTop()
      for (let frame = 0; frame < frames; frame += 1) {
        pumpFrame(frameMs)
      }
      const scrolled = drag.fake.scrollTop() - baseline
      drag.handle.dispose()
      return scrolled
    }

    expect(scrollAfterFrames(8, 4)).toBeCloseTo(scrollAfterFrames(16, 2), 5)
  })

  it('stops at the top of the document instead of scrolling past it', () => {
    const drag = mountDrag()

    drag.pressLine(2)
    firePointerEvent(document, 'pointermove', { clientY: FAKE_EDITOR_TOP_PX - 40 })
    pumpFrame()

    expect(drag.fake.scrollTop()).toBe(0)
    // Nothing left to pull, so the loop stops instead of spinning.
    expect(pendingFrameCount()).toBe(0)
    drag.handle.dispose()
  })
})
