import type { editor } from 'monaco-editor'

// monaco-vim is a keymap emulator, not Neovim: motions/operators/basic Ex commands work, but
// LSP-backed motions (`gd`), `:%s` live preview (`inccommand`), and macro replay (`@q`) are not
// supported. Those are documented as known limitations rather than patched in the vendored lib.
export type VimModeController = { dispose: () => void }

// Why: monaco-vim registers Ex commands on a process-global Vim singleton, so `:w` must
// route to whichever editor currently holds focus rather than a single captured instance.
let activeWrite: (() => void) | null = null
let exCommandsRegistered = false

type VimExApi = {
  defineEx: (name: string, shorthand: string, handler: () => void) => void
}

/** Register `:w`/`:wq`/`:x` once on monaco-vim's process-global Vim singleton (idempotent). */
function ensureExCommands(vimMode: unknown): void {
  if (exCommandsRegistered) {
    return
  }
  // Why: monaco-vim ships loose `any` types; the Ex registry lives on the exported adapter.
  const vimApi = (vimMode as { Vim?: VimExApi }).Vim
  if (!vimApi) {
    return
  }
  exCommandsRegistered = true
  const write = (): void => activeWrite?.()
  vimApi.defineEx('write', 'w', write)
  vimApi.defineEx('wq', 'wq', write)
  vimApi.defineEx('x', 'x', write)
}

/**
 * Enable Vim keybindings on a Monaco editor, writing mode/keystroke feedback into
 * `statusBarNode`. `onWrite` is invoked for `:w`/`:wq`/`:x` while this editor holds focus.
 * monaco-vim is imported lazily so merely loading the editor (in tests, or for users on the
 * default keymap) never pulls in the adapter or its deep monaco-editor imports.
 */
export async function installMonacoVimMode(
  editorInstance: editor.IStandaloneCodeEditor,
  statusBarNode: HTMLElement,
  onWrite: () => void
): Promise<VimModeController> {
  const { initVimMode, VimMode } = await import('monaco-vim')
  ensureExCommands(VimMode)
  const vim = initVimMode(editorInstance, statusBarNode)
  // Why: only claim the shared `:w` handler if this editor already has focus; otherwise let
  // onDidFocusEditorText claim it on focus, so mounting an unfocused split/tab editor can't
  // hijack `:w` from the currently focused one.
  if (editorInstance.hasTextFocus()) {
    activeWrite = onWrite
  }
  const focusSub = editorInstance.onDidFocusEditorText(() => {
    activeWrite = onWrite
  })
  let disposed = false
  return {
    dispose: (): void => {
      if (disposed) {
        return
      }
      disposed = true
      focusSub.dispose()
      if (activeWrite === onWrite) {
        activeWrite = null
      }
      vim.dispose()
    }
  }
}
