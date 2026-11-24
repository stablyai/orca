import type { Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'
import { createDebugGutterExtension, type BreakpointPopoverRequest } from './breakpoint-gutter'
import {
  createDebugInlineValuesExtension,
  type DebugValueInspectRequest
} from './debug-inline-values'
import { createDebugRunToCursorExtension } from './debug-run-to-cursor'
import { createDebugSmartStepExtension } from './debug-smart-step'
import {
  createDebugQuickEvaluateExtension,
  createDebugValueHoverExtension
} from './debug-value-hover'

export function createCodeMirrorDebugExtensions(params: {
  filePath: string
  fileKey: string
  runToCursor: string
  resume: string
  onOpenBreakpointPopover: (req: BreakpointPopoverRequest) => void
  onInspectValue: (req: DebugValueInspectRequest) => void
}): Extension[] {
  return [
    createDebugGutterExtension(params.filePath, params.fileKey, params.onOpenBreakpointPopover),
    createDebugInlineValuesExtension(params.fileKey, params.onInspectValue),
    createDebugValueHoverExtension(params.onInspectValue),
    createDebugQuickEvaluateExtension(params.onInspectValue),
    createDebugRunToCursorExtension(params.filePath, params.fileKey, {
      runToCursor: params.runToCursor,
      resume: params.resume
    }),
    createDebugSmartStepExtension(params.fileKey)
  ]
}

export type SaveAndDebugContext = {
  filePath: string
  fileKey: string
  readOnly: boolean
  onSave: (content: string) => void
}

export function triggerSmartStepFromEditorView(view: EditorView | null, fileKey: string): void {
  const dbg = useDebugSessionStore.getState()
  const stopped = dbg.stoppedLocation
  if (
    view &&
    stopped &&
    stopped.fileKey === fileKey &&
    stopped.line >= 1 &&
    stopped.line <= view.state.doc.lines
  ) {
    const lineInfo = view.state.doc.line(stopped.line)
    void dbg.startSmartStepInto({ fileKey, line: stopped.line, text: lineInfo.text })
    return
  }
  void dbg.startSmartStepInto(null)
}

export function createSaveAndDebugKeymap(getContext: () => SaveAndDebugContext): Extension {
  return keymap.of([
    {
      key: 'Mod-s',
      run: (view) => {
        const ctx = getContext()
        if (!ctx.readOnly) {
          ctx.onSave(view.state.doc.toString())
        }
        return true
      }
    },
    {
      key: 'F5',
      run: () => {
        const dbg = useDebugSessionStore.getState()
        if (dbg.status === 'stopped') {
          void dbg.resume()
          return true
        }
        return false
      }
    },
    {
      key: 'Shift-F5',
      run: () => {
        const dbg = useDebugSessionStore.getState()
        if (dbg.sessionId !== null) {
          void dbg.stopSession()
          return true
        }
        return false
      }
    },
    {
      key: 'F10',
      run: () => {
        const dbg = useDebugSessionStore.getState()
        if (dbg.status === 'stopped') {
          void dbg.stepOver()
          return true
        }
        return false
      }
    },
    {
      key: 'F11',
      run: () => {
        const dbg = useDebugSessionStore.getState()
        if (dbg.status === 'stopped') {
          void dbg.stepInto()
          return true
        }
        return false
      }
    },
    {
      key: 'Shift-F11',
      run: () => {
        const dbg = useDebugSessionStore.getState()
        if (dbg.status === 'stopped') {
          void dbg.stepOut()
          return true
        }
        return false
      }
    },
    {
      key: 'Shift-F7',
      run: (view) => {
        const dbg = useDebugSessionStore.getState()
        if (dbg.status !== 'stopped') {
          return false
        }
        triggerSmartStepFromEditorView(view, getContext().fileKey)
        return true
      }
    },
    {
      key: 'Alt-F9',
      run: (view) => {
        const dbg = useDebugSessionStore.getState()
        if (dbg.status !== 'stopped') {
          return false
        }
        const ctx = getContext()
        const line1Based = view.state.doc.lineAt(view.state.selection.main.head).number
        void dbg.runToCursor(ctx.filePath, line1Based, false)
        return true
      }
    }
  ])
}
