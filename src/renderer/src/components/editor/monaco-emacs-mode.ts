import type { editor } from 'monaco-editor'
import type * as MonacoEmacs from 'monaco-emacs'

// monaco-emacs is a keymap layer over Monaco commands, not an Emacs engine. Verified against the
// monaco-editor 0.55.1 Orca ships: movement, mark (`C-SPC`), kill ring (`C-k`/`C-w`/`M-w`/`C-y`/
// `M-y`), undo, `C-u` numeric arguments and the `C-x`/`M-g` prefixes. Its `C-s`/`C-r` only open
// Monaco's find widget (no incremental direction) and `C-g` does not close it; that wiring is
// Orca's and is tracked in #30055.
export type EmacsModeController = { dispose: () => void }

type MonacoEmacsModule = typeof MonacoEmacs

// Why: monaco-emacs keeps one process-global command table, so adjust it once, not per editor.
let commandTableAdjusted = false

function ensureCommandTable(mod: MonacoEmacsModule): void {
  if (commandTableAdjusted) {
    return
  }
  commandTableAdjusted = true
  // Why: upstream binds plain Tab to formatDocument, which rewrites the whole file on the key every
  // editor user presses to indent. Emacs TAB indents, so hand the key back to Monaco.
  mod.unregisterKey('Tab')
  // Emacs select-all and a redo binding are missing upstream.
  mod.registerGlobalCommand('C-x h', {
    description: 'Select all',
    action: 'editor.action.selectAll'
  })
  mod.registerGlobalCommand('S-C-z', new mod.Actions.RedoAction())
}

/**
 * Enable Emacs keybindings on a Monaco editor, mirroring the echo area into `statusBarNode`: the
 * pending prefix or `C-u` argument, and whether the mark is active. monaco-emacs is imported
 * lazily so loading the editor on the default keymap never pulls in the adapter.
 */
export async function installMonacoEmacsMode(
  editorInstance: editor.IStandaloneCodeEditor,
  statusBarNode: HTMLElement
): Promise<EmacsModeController> {
  const mod = await import('monaco-emacs')
  ensureCommandTable(mod)
  const extension = new mod.EmacsExtension(editorInstance)

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
  })
  const markSub = extension.onDidMarkChange((active) => {
    markActive = active
    render()
  })
  extension.start()
  render()

  let disposed = false
  return {
    dispose: (): void => {
      if (disposed) {
        return
      }
      disposed = true
      keySub.dispose()
      markSub.dispose()
      extension.dispose()
      statusBarNode.textContent = ''
    }
  }
}
