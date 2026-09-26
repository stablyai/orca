import type { editor as MonacoEditor, IDisposable } from 'monaco-editor'

// A Monaco stand-in for the diff-comment suites: enough of ICodeEditor for the decorator, the
// add-button overlay and the gutter range drag, with the scroll/hit-test geometry scriptable so
// a test can place the pointer on a line without a layout engine.

export const FAKE_LINE_HEIGHT_PX = 20
export const FAKE_EDITOR_TOP_PX = 100
export const FAKE_EDITOR_HEIGHT_PX = 400

export type FakeDecoration = {
  startLine: number
  endLine: number
  className?: string | null
  marginClassName?: string | null
}

export type FakeDiffCommentEditor = {
  editor: MonacoEditor.ICodeEditor
  domNode: HTMLElement
  zones: Map<string, MonacoEditor.IViewZone>
  decorations: () => readonly FakeDecoration[]
  decorationWrites: () => number
  scrollTop: () => number
  emitMouseMove: (lineNumber: number) => void
  emitDispose: () => void
  /** Viewport-relative Y for a line, as the fake hit-test reads it. */
  clientYForLine: (lineNumber: number) => number
  setLineCount: (lineCount: number) => void
}

type FakeEditorOptions = {
  lineCount?: number
  /** Lines the fake hit-test refuses to resolve, standing in for Monaco returning no position. */
  unresolvableLines?: readonly number[]
  /**
   * An x band the hit-test refuses to resolve, standing in for the overlay's own "+" button:
   * Monaco reports no position for a point over a DOM node it does not own.
   */
  deadColumn?: { fromX: number; toX: number }
  /** MouseTargetType the hit-test reports, for the gesture's gutter-target filter. */
  gutterTargetType?: MonacoEditor.MouseTargetType
}

export function createFakeDiffCommentEditor(
  options: FakeEditorOptions = {}
): FakeDiffCommentEditor {
  const domNode = document.createElement('div')
  // A fixed viewport rectangle: happy-dom lays nothing out, and the drag controller only ever
  // measures the editor's top and bottom edges against the pointer.
  const editorRect: DOMRect = {
    top: FAKE_EDITOR_TOP_PX,
    bottom: FAKE_EDITOR_TOP_PX + FAKE_EDITOR_HEIGHT_PX,
    left: 0,
    right: 600,
    width: 600,
    height: FAKE_EDITOR_HEIGHT_PX,
    x: 0,
    y: FAKE_EDITOR_TOP_PX,
    toJSON: () => ({})
  }
  domNode.getBoundingClientRect = () => editorRect
  document.body.appendChild(domNode)

  const zones = new Map<string, MonacoEditor.IViewZone>()
  const unresolvable = new Set(options.unresolvableLines ?? [])
  let lineCount = options.lineCount ?? 1000
  let nextZoneId = 0
  let scrollTop = 0
  let decorations: FakeDecoration[] = []
  let decorationWrites = 0
  const mouseMoveListeners: ((e: { target: { position: { lineNumber: number } } }) => void)[] = []
  const disposeListeners: (() => void)[] = []
  const noopDisposable: IDisposable = { dispose: () => {} }
  // Monaco hands back the same model reference until the model is replaced.
  const model = { getLineCount: () => lineCount }

  const clientYForLine = (lineNumber: number): number =>
    FAKE_EDITOR_TOP_PX + (lineNumber - 1) * FAKE_LINE_HEIGHT_PX - scrollTop + 1

  const lineAtClientY = (clientY: number): number | null => {
    const line = Math.floor((clientY - FAKE_EDITOR_TOP_PX + scrollTop) / FAKE_LINE_HEIGHT_PX) + 1
    if (line < 1 || line > lineCount || unresolvable.has(line)) {
      return null
    }
    return line
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the subset of ICodeEditor the diff-comment modules call; every member they reach is implemented below.
  const editor = {
    getDomNode: () => domNode,
    getContainerDomNode: () => domNode,
    getModel: () => model,
    getOption: () => FAKE_LINE_HEIGHT_PX,
    getTopForLineNumber: (lineNumber: number) => (lineNumber - 1) * FAKE_LINE_HEIGHT_PX,
    getScrollTop: () => scrollTop,
    setScrollTop: (next: number) => {
      scrollTop = next
    },
    getScrollHeight: () => lineCount * FAKE_LINE_HEIGHT_PX,
    getLayoutInfo: () => ({ height: FAKE_EDITOR_HEIGHT_PX, contentLeft: 60 }),
    getSelection: () => null,
    deltaDecorations: () => [],
    createDecorationsCollection: () => ({
      set: (next: MonacoEditor.IModelDeltaDecoration[]) => {
        decorationWrites += 1
        decorations = next.map((decoration) => ({
          startLine: decoration.range.startLineNumber,
          endLine: decoration.range.endLineNumber,
          className: decoration.options.className,
          marginClassName: decoration.options.marginClassName
        }))
      },
      clear: () => {
        decorationWrites += 1
        decorations = []
      }
    }),
    getTargetAtClientPoint: (clientX: number, clientY: number) => {
      const dead = options.deadColumn
      if (dead && clientX >= dead.fromX && clientX <= dead.toX) {
        return null
      }
      const lineNumber = lineAtClientY(clientY)
      return lineNumber === null
        ? null
        : {
            type: options.gutterTargetType ?? 3 /* GUTTER_LINE_NUMBERS */,
            position: { lineNumber }
          }
    },
    onMouseMove: (listener: (e: { target: { position: { lineNumber: number } } }) => void) => {
      mouseMoveListeners.push(listener)
      return noopDisposable
    },
    onMouseLeave: () => noopDisposable,
    onDidScrollChange: () => noopDisposable,
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener)
      return noopDisposable
    },
    changeViewZones: (callback: (accessor: MonacoEditor.IViewZoneChangeAccessor) => void) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the decorator calls only addZone/removeZone on the accessor, both implemented here.
      callback({
        addZone: (zone: MonacoEditor.IViewZone) => {
          const id = `zone-${(nextZoneId += 1)}`
          zones.set(id, zone)
          return id
        },
        removeZone: (id: string) => {
          zones.delete(id)
        },
        layoutZone: () => {}
      } as unknown as MonacoEditor.IViewZoneChangeAccessor)
  } as unknown as MonacoEditor.ICodeEditor

  return {
    editor,
    domNode,
    zones,
    decorations: () => decorations,
    decorationWrites: () => decorationWrites,
    scrollTop: () => scrollTop,
    clientYForLine,
    setLineCount: (next) => {
      lineCount = next
    },
    emitMouseMove: (lineNumber) => {
      for (const listener of mouseMoveListeners) {
        listener({ target: { position: { lineNumber } } })
      }
    },
    emitDispose: () => {
      for (const listener of disposeListeners) {
        listener()
      }
    }
  }
}
