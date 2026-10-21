import { KeyCode, KeyMod, editor as monacoEditor } from 'monaco-editor'
import type * as MonacoEmacs from 'monaco-emacs'

// monaco-emacs is a keymap layer over Monaco commands, not an Emacs engine. Verified against the
// monaco-editor 0.55.1 Orca ships: movement, mark (`C-SPC`), kill ring (`C-k`/`C-w`/`M-w`/`C-y`/
// `M-y`), undo, `C-u` numeric arguments and the `C-x`/`M-g` prefixes. Its `C-s`/`C-r` open Monaco's
// find widget; the isearch-style keys inside the widget, `C-g` closing it, and `C-x C-s` are Orca's.
export type EmacsModeController = { dispose: () => void }

/** What the Emacs table routes to Orca for the editor that received the key. */
export type EmacsEditorHooks = { onSave: () => void }

type MonacoEmacsModule = typeof MonacoEmacs

const SOURCE = 'orca.emacs'
// Scopes the find-widget rules to editors running the preset; Monaco keybinding rules are global.
const EMACS_KEYMAP_CONTEXT_KEY = 'orcaEmacsKeymap'
const IN_FIND_WIDGET = `${EMACS_KEYMAP_CONTEXT_KEY} && findWidgetVisible`

// Why: monaco-emacs keeps one process-global command table, so `C-x C-s` must find the hooks of
// whichever editor the key landed in.
const hooksByEditor = new WeakMap<monacoEditor.IStandaloneCodeEditor, EmacsEditorHooks>()

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
  // Emacs select-all and redo are missing upstream; redo takes Emacs 28's `undo-redo` keys
  // (`C-?`, `C-M-_`) plus `S-C-z` for editor habit.
  mod.registerGlobalCommand('C-x h', {
    description: 'Select all',
    action: 'editor.action.selectAll'
  })
  const redo = new mod.Actions.RedoAction()
  for (const key of ['S-C-/', 'S-C-M--', 'S-C-z']) {
    mod.registerGlobalCommand(key, redo)
  }
  mod.registerGlobalCommand('C-x C-s', {
    description: 'Save file',
    run: (editorInstance) => hooksByEditor.get(editorInstance)?.onSave()
  })
  // Why: keyboard-quit ends an isearch in Emacs; upstream leaves the find widget open.
  const keyboardQuit = new mod.Actions.KeyBoardQuit()
  mod.registerGlobalCommand('C-g', {
    description: 'Keyboard quit',
    run: (editorInstance, extension, repeat, repeatedTrigger) => {
      keyboardQuit.run(editorInstance, extension, repeat, repeatedTrigger)
      // No-op unless the widget is visible: the command's precondition gates it.
      editorInstance.trigger(SOURCE, 'closeFindWidget', null)
    }
  })
  // Why: keys typed into the find widget never reach monaco-emacs's editor listener, so the isearch
  // keys there are Monaco keybinding rules instead. WinCtrl is the physical Control key everywhere.
  monacoEditor.addKeybindingRules([
    {
      keybinding: KeyMod.WinCtrl | KeyCode.KeyS,
      command: 'editor.action.nextMatchFindAction',
      when: IN_FIND_WIDGET
    },
    {
      keybinding: KeyMod.WinCtrl | KeyCode.KeyR,
      command: 'editor.action.previousMatchFindAction',
      when: IN_FIND_WIDGET
    },
    { keybinding: KeyMod.WinCtrl | KeyCode.KeyG, command: 'closeFindWidget', when: IN_FIND_WIDGET }
  ])
}

/**
 * Enable Emacs keybindings on a Monaco editor, mirroring the echo area into `statusBarNode`: the
 * pending prefix or `C-u` argument, and whether the mark is active. monaco-emacs is imported
 * lazily so loading the editor on the default keymap never pulls in the adapter.
 */
export async function installMonacoEmacsMode(
  editorInstance: monacoEditor.IStandaloneCodeEditor,
  statusBarNode: HTMLElement,
  hooks: EmacsEditorHooks
): Promise<EmacsModeController> {
  const mod = await import('monaco-emacs')
  ensureCommandTable(mod)
  hooksByEditor.set(editorInstance, hooks)
  const keymapContext = editorInstance.createContextKey<boolean>(EMACS_KEYMAP_CONTEXT_KEY, true)
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
      keymapContext.set(false)
      hooksByEditor.delete(editorInstance)
      statusBarNode.textContent = ''
    }
  }
}
