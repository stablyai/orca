import { KeyCode, KeyMod, editor as monacoEditor } from 'monaco-editor'
import type * as MonacoEmacs from 'monaco-emacs'

// monaco-emacs maps keys onto Monaco commands; `C-u` arguments don't work upstream (it expects `4`, Monaco sends `Digit4`).
export type EmacsModeController = { dispose: () => void }

export type EmacsWindowSplitDirection = 'right' | 'down'

/** What the Emacs table routes to Orca for the editor that received the key. */
export type EmacsEditorHooks = {
  onSave: () => void
  onSplitWindow: (direction: EmacsWindowSplitDirection) => void
  onOtherWindow: () => void
  onDeleteWindow: () => void
}

// monaco-emacs keeps Monaco's `Digit` key names, so Emacs `C-x 2` arrives as `C-x Digit2`.
const WINDOW_COMMANDS: readonly [string, string, (hooks: EmacsEditorHooks) => void][] = [
  ['C-x Digit2', 'Split window below', (hooks) => hooks.onSplitWindow('down')],
  ['C-x Digit3', 'Split window right', (hooks) => hooks.onSplitWindow('right')],
  ['C-x o', 'Other window', (hooks) => hooks.onOtherWindow()],
  ['C-x Digit0', 'Delete window', (hooks) => hooks.onDeleteWindow()]
]

type MonacoEmacsModule = typeof MonacoEmacs

const SOURCE = 'orca.emacs'
// Scopes the find-widget rules to editors running the preset; Monaco keybinding rules are global.
const EMACS_KEYMAP_CONTEXT_KEY = 'orcaEmacsKeymap'
const IN_FIND_WIDGET = `${EMACS_KEYMAP_CONTEXT_KEY} && findWidgetVisible`

// The command table is process-global, so commands look up the hooks of the editor that got the key.
const hooksByEditor = new WeakMap<monacoEditor.IStandaloneCodeEditor, EmacsEditorHooks>()

let commandTableAdjusted = false

function ensureCommandTable(mod: MonacoEmacsModule): void {
  if (commandTableAdjusted) {
    return
  }
  commandTableAdjusted = true
  // Upstream binds Tab to formatDocument; Emacs TAB indents.
  mod.unregisterKey('Tab')
  // Upstream lacks select-all and redo; redo uses Emacs 28 `undo-redo` keys plus `S-C-z`.
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
  for (const [key, description, invoke] of WINDOW_COMMANDS) {
    mod.registerGlobalCommand(key, {
      description,
      run: (editorInstance) => {
        const hooks = hooksByEditor.get(editorInstance)
        if (hooks) {
          invoke(hooks)
        }
      }
    })
  }
  // Emacs keyboard-quit ends isearch; upstream leaves the find widget open.
  const keyboardQuit = new mod.Actions.KeyBoardQuit()
  mod.registerGlobalCommand('C-g', {
    description: 'Keyboard quit',
    run: (editorInstance, extension, repeat, repeatedTrigger) => {
      keyboardQuit.run(editorInstance, extension, repeat, repeatedTrigger)
      editorInstance.trigger(SOURCE, 'closeFindWidget', null)
    }
  })
  // Find-widget keys bypass monaco-emacs's editor listener; WinCtrl is physical Control on every platform.
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

/** Mirrors the pending prefix and mark into `statusBarNode`; imported lazily to keep the default keymap light. */
export async function installMonacoEmacsMode(
  editorInstance: monacoEditor.IStandaloneCodeEditor,
  statusBarNode: HTMLElement,
  hooks: EmacsEditorHooks,
  isCancelled: () => boolean = () => false
): Promise<EmacsModeController> {
  const mod = await import('monaco-emacs')
  // A newer install may own this editor's hooks; disposing late would remove them.
  if (isCancelled()) {
    return { dispose: () => {} }
  }
  ensureCommandTable(mod)
  hooksByEditor.set(editorInstance, hooks)
  const keymapContext = editorInstance.createContextKey<boolean>(EMACS_KEYMAP_CONTEXT_KEY, true)
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
      keymapContext.set(false)
      hooksByEditor.delete(editorInstance)
      statusBarNode.textContent = ''
    }
  }
}
