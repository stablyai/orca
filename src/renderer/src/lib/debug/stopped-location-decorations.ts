import type { editor, IDisposable } from 'monaco-editor'
import type { DebugSessionStore } from './use-debug-session'
import type { DebugEditorBinding } from './connect-debug-editor'

export const STOPPED_LINE_CLASS = 'orca-debug-stopped-line'
export const STOPPED_ARROW_CLASS = 'orca-debug-stopped-arrow'
export const FRAME_LINE_CLASS = 'orca-debug-frame-line'
export const FRAME_ARROW_CLASS = 'orca-debug-frame-arrow'

export const DEBUG_GLYPH_CSS = `
.monaco-editor .${STOPPED_LINE_CLASS} { background: var(--status-warning-background); }
.monaco-editor .${FRAME_LINE_CLASS} { background: color-mix(in srgb, var(--status-warning) 6%, transparent); }
.monaco-editor .${STOPPED_ARROW_CLASS}::after, .monaco-editor .${FRAME_ARROW_CLASS}::after { content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-style: solid; border-width: 5px 0 5px 8px; border-color: transparent transparent transparent var(--status-warning); }
.monaco-editor .${FRAME_ARROW_CLASS}::after { border-left-color: var(--muted-foreground); }
`

export type StoppedLocationReveal = {
  isOpen: (filePath: string) => boolean
  open: (filePath: string, rootPath: string, line: number, column: number) => void
}

type Deps = {
  sessionStore: DebugSessionStore
  reveal: StoppedLocationReveal
}

/** Per store and session root: the selection epoch whose top frame was already opened or requested. */
type EpochMarks = {
  revealed: Map<string, number>
  framesRequested: Map<string, number>
}
const marksByStore = new WeakMap<DebugSessionStore, EpochMarks>()

function marksFor(store: DebugSessionStore): EpochMarks {
  const marks = marksByStore.get(store) ?? {
    revealed: new Map(),
    framesRequested: new Map()
  }
  marksByStore.set(store, marks)
  return marks
}

export function installStoppedLocation(
  editorInstance: editor.IStandaloneCodeEditor,
  binding: DebugEditorBinding,
  { sessionStore, reveal }: Deps
): IDisposable & { update: () => void } {
  const collection = editorInstance.createDecorationsCollection()
  const marks = marksFor(sessionStore)
  let scrolledEpoch: number | null = null

  function update(): void {
    const coreRoot = binding.getCoreRoot()
    const state = coreRoot === null ? null : sessionStore.getState(coreRoot)
    if (coreRoot === null || !state?.snapshot?.stopped) {
      collection.clear()
      scrolledEpoch = null
      return
    }
    const { frames, selectedFrameId, selectedThreadId, selectionEpoch } = state
    if (frames.length === 0 && selectedThreadId !== null) {
      if (marks.framesRequested.get(coreRoot) !== selectionEpoch) {
        marks.framesRequested.set(coreRoot, selectionEpoch)
        void sessionStore.loadFrames({
          ...binding.target,
          worktreePath: coreRoot
        })
      }
      return
    }
    const top = frames[0]
    if (top?.source?.path && marks.revealed.get(coreRoot) !== selectionEpoch) {
      marks.revealed.set(coreRoot, selectionEpoch)
      const path = binding.toEditorPath(top.source.path)
      if (!binding.isThisFile(top.source.path) && !reveal.isOpen(path)) {
        reveal.open(path, binding.target.worktreePath, top.line, top.column)
      }
    }
    const frame = frames.find((f) => f.id === selectedFrameId)
    if (!frame || !binding.isThisFile(frame.source?.path)) {
      collection.clear()
      return
    }
    const isTop = frame === top
    collection.set([
      {
        range: {
          startLineNumber: frame.line,
          startColumn: 1,
          endLineNumber: frame.line,
          endColumn: 1
        },
        options: {
          isWholeLine: true,
          className: isTop ? STOPPED_LINE_CLASS : FRAME_LINE_CLASS,
          glyphMarginClassName: isTop ? STOPPED_ARROW_CLASS : FRAME_ARROW_CLASS
        }
      }
    ])
    if (scrolledEpoch !== selectionEpoch) {
      scrolledEpoch = selectionEpoch
      editorInstance.revealLineInCenterIfOutsideViewport(frame.line)
    }
  }

  const unsubscribe = sessionStore.subscribe(update)
  update()
  return {
    update,
    dispose: () => {
      unsubscribe()
      collection.clear()
    }
  }
}
