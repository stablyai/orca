import type { editor } from 'monaco-editor'
import type * as MonacoEmacs from 'monaco-emacs'

// monaco-emacs maps keys onto Monaco commands; `C-u` arguments don't work upstream (it expects `4`, Monaco sends `Digit4`).
export type EmacsModeController = { dispose: () => void }

export type EmacsEditorHooks = { onSave: () => void }

type MonacoEmacsModule = typeof MonacoEmacs

// The command table is process-global, so commands look up the hooks of the editor that got the key.
const hooksByEditor = new WeakMap<editor.IStandaloneCodeEditor, EmacsEditorHooks>()

let commandTableAdjusted = false

function ensureCommandTable(mod: MonacoEmacsModule): void {
  if (commandTableAdjusted) {
    return
  }
  commandTableAdjusted = true
  // Upstream binds Tab to formatDocument; Emacs TAB indents.
  mod.unregisterKey('Tab')
  // Upstream lacks select-all and a redo binding.
  mod.registerGlobalCommand('C-x h', { action: 'editor.action.selectAll' })
  mod.registerGlobalCommand('S-C-z', new mod.Actions.RedoAction())
  mod.registerGlobalCommand('C-x C-s', {
    run: (editorInstance) => hooksByEditor.get(editorInstance)?.onSave()
  })
}

/** Mirrors the pending prefix and mark into `statusBarNode`; imported lazily to keep the default keymap light. */
export async function installMonacoEmacsMode(
  editorInstance: editor.IStandaloneCodeEditor,
  statusBarNode: HTMLElement,
  hooks: EmacsEditorHooks,
  isCancelled: () => boolean = () => false
): Promise<EmacsModeController> {
  const mod = await import('monaco-emacs')
  // A newer install may own this editor; starting and disposing late would undo its setup.
  if (isCancelled()) {
    return { dispose: () => {} }
  }
  ensureCommandTable(mod)
  hooksByEditor.set(editorInstance, hooks)
  const extension = new mod.EmacsExtension(editorInstance)

  let disposed = false
  let keyState = ''
  let markActive = false
  const render = (): void => {
    statusBarNode.textContent = [keyState.trim(), markActive ? 'Mark set' : '']
      .filter(Boolean)
      .join('  ')
  }
  const keySub = extension.onDidChangeKey((state) => {
    keyState = state
    render()
    // Upstream echoes before running the command and never after the reset, so re-read once keydown returns.
    queueMicrotask(() => {
      if (!disposed) {
        keyState = extension.state.getReadableState()
        render()
      }
    })
  })
  const markSub = extension.onDidMarkChange((active) => {
    markActive = active
    render()
  })
  extension.start()
  render()

  return {
    dispose: (): void => {
      if (disposed) {
        return
      }
      disposed = true
      keySub.dispose()
      markSub.dispose()
      extension.dispose()
      hooksByEditor.delete(editorInstance)
      statusBarNode.textContent = ''
    }
  }
}
