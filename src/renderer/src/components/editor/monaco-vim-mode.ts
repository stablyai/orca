import type { editor } from 'monaco-editor'

// monaco-vim is a keymap emulator, not Neovim. Verified working against the live editor: motions,
// operators, registers (yank/paste), visual mode, macros (`qa`…`q` / `@a`), and `:%s` substitution.
// Editor-display `:set` options (wrap/number/tabstop) aren't vim-engine concerns, so Orca maps them
// onto Monaco here. Documented monaco-vim quirks (Orca's save/sync are verified clean, so these are
// the vendored engine's): `gd` and `:%s` live-preview (`inccommand`) are unsupported; Backspace in a
// recorded macro isn't replayed; and linewise paste of a newline-terminated buffer adds one trailing
// blank line. See tests/e2e/vim-keybindings-file-editor.spec.ts.
export type VimModeController = { dispose: () => void }

/** The focused editor's hooks Ex commands route to: save, close, and the editor for `:set`. */
export type VimEditorActions = {
  onWrite: () => void
  onClose: () => void
  editor: editor.IStandaloneCodeEditor
}

// Why: monaco-vim registers Ex commands on a process-global Vim singleton, so `:w`/`:q`/`:set` must
// route to whichever editor currently holds focus rather than a single captured instance.
let active: VimEditorActions | null = null
let exCommandsRegistered = false

type VimExParams = { args?: string[]; argString?: string }
type VimExApi = {
  defineEx: (
    name: string,
    shorthand: string,
    handler: (ctx: unknown, params: VimExParams) => void
  ) => void
}

/**
 * Apply one `:set` token (e.g. `nowrap`, `number`, `tabstop=4`) to the Monaco editor. Monaco has no
 * terminal-style paste-mangling to disable, so `:set paste`/`nopaste` and any unrecognized option
 * are accepted as no-ops rather than erroring.
 */
function applySetOption(ed: editor.IStandaloneCodeEditor, token: string): void {
  const [rawName, rawValue] = token.split('=')
  const name = rawName.trim()
  const size = Number.parseInt(rawValue ?? '', 10)
  const hasSize = Number.isFinite(size) && size > 0
  switch (name) {
    case 'wrap':
      ed.updateOptions({ wordWrap: 'on' })
      break
    case 'nowrap':
      ed.updateOptions({ wordWrap: 'off' })
      break
    case 'number':
    case 'nu':
      ed.updateOptions({ lineNumbers: 'on' })
      break
    case 'nonumber':
    case 'nonu':
      ed.updateOptions({ lineNumbers: 'off' })
      break
    case 'tabstop':
    case 'ts':
      if (hasSize) {
        ed.getModel()?.updateOptions({ tabSize: size })
      }
      break
    case 'shiftwidth':
    case 'sw':
      if (hasSize) {
        ed.getModel()?.updateOptions({ indentSize: size })
      }
      break
    case 'expandtab':
    case 'et':
      ed.getModel()?.updateOptions({ insertSpaces: true })
      break
    case 'noexpandtab':
    case 'noet':
      ed.getModel()?.updateOptions({ insertSpaces: false })
      break
    default:
      break
  }
}

/** Register `:w`/`:q`/`:q!`/`:wq`/`:x`/`:set` once on monaco-vim's process-global Vim singleton. */
function ensureExCommands(vimMode: unknown): void {
  if (exCommandsRegistered) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: monaco-vim 0.4.4 attaches its Vim engine (carrying defineEx) as a runtime-only `.Vim` property on the exported adapter, absent from the package's published types; the `if (!vimApi)` guard below tolerates its absence.
  const vimApi = (vimMode as { Vim?: VimExApi }).Vim
  if (!vimApi) {
    return
  }
  exCommandsRegistered = true
  // Why: defer close so monaco-vim finishes dispatching the Ex command before the editor (and this
  // adapter) unmounts; capture the invoking editor so a focus change in the same tick can't
  // redirect the close to another editor.
  const close = (): void => {
    const target = active
    queueMicrotask(() => target?.onClose())
  }
  const writeThenClose = (): void => {
    const target = active
    target?.onWrite()
    queueMicrotask(() => target?.onClose())
  }
  vimApi.defineEx('write', 'w', () => active?.onWrite())
  // `:q!`/`:wq!` route to these same handlers (monaco-vim parses the trailing `!` as force); Orca's
  // autosave-backed close covers both the plain and forced forms.
  vimApi.defineEx('quit', 'q', close)
  vimApi.defineEx('wq', 'wq', writeThenClose)
  vimApi.defineEx('xit', 'x', writeThenClose)
  vimApi.defineEx('set', 'se', (_ctx, params) => {
    const ed = active?.editor
    if (!ed) {
      return
    }
    const tokens = params.args?.length
      ? params.args
      : (params.argString ?? '').split(/\s+/).filter(Boolean)
    for (const token of tokens) {
      applySetOption(ed, token)
    }
  })
}

/**
 * Enable Vim keybindings on a Monaco editor, writing mode/keystroke feedback into
 * `statusBarNode`. Ex commands route to this editor while it holds focus: `:w`/`:wq`/`:x` run
 * `actions.onWrite`, `:q`/`:q!`/`:wq`/`:x` run `actions.onClose`, and `:set` adjusts the editor.
 * monaco-vim is imported lazily so merely loading the editor (in tests, or for users on the default
 * keymap) never pulls in the adapter or its deep monaco-editor imports.
 */
export async function installMonacoVimMode(
  editorInstance: editor.IStandaloneCodeEditor,
  statusBarNode: HTMLElement,
  actions: VimEditorActions
): Promise<VimModeController> {
  const { initVimMode, VimMode } = await import('monaco-vim')
  ensureExCommands(VimMode)
  const vim = initVimMode(editorInstance, statusBarNode)
  // Why: only claim the shared handlers if this editor already has focus; otherwise let
  // onDidFocusEditorText claim them on focus, so mounting an unfocused split/tab editor can't
  // hijack `:w`/`:q` from the currently focused one.
  if (editorInstance.hasTextFocus()) {
    active = actions
  }
  const focusSub = editorInstance.onDidFocusEditorText(() => {
    active = actions
  })
  let disposed = false
  return {
    dispose: (): void => {
      if (disposed) {
        return
      }
      disposed = true
      focusSub.dispose()
      if (active === actions) {
        active = null
      }
      vim.dispose()
    }
  }
}
