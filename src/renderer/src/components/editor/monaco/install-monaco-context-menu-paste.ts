import type * as Monaco from 'monaco-editor'
import { PasteAction } from 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js'
import { InMemoryClipboardMetadataManager } from 'monaco-editor/esm/vs/editor/browser/controller/editContext/clipboardUtils.js'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  ORCA_CONTEXT_MENU_PASTE_NAME,
  ORCA_CONTEXT_MENU_PASTE_PRIORITY,
  runOrcaContextMenuPaste
} from './monaco-context-menu-paste'

let installed = false

/** Route Monaco Paste through trusted IPC because the sandbox blocks navigator.clipboard; install once. */
export function installMonacoContextMenuPaste(monaco: typeof Monaco): void {
  // PasteAction is absent when the browser reports no paste support.
  if (installed || !PasteAction) {
    return
  }
  installed = true

  // Priority beats Monaco’s 10000; a truthy Promise stops MultiCommand, while false yields read-only/unfocused cases to the default.
  PasteAction.addImplementation(
    ORCA_CONTEXT_MENU_PASTE_PRIORITY,
    ORCA_CONTEXT_MENU_PASTE_NAME,
    () =>
      runOrcaContextMenuPaste({
        getFocusedEditor: () =>
          monaco.editor.getEditors().find((candidate) => candidate.hasTextFocus()) ?? null,
        readClipboardText: (options) => window.api.ui.readClipboardText(options),
        getClipboardMetadata: (text) => InMemoryClipboardMetadataManager.INSTANCE.get(text),
        emptySelectionClipboardOptionId: monaco.editor.EditorOption.emptySelectionClipboard,
        readOnlyOptionId: monaco.editor.EditorOption.readOnly,
        onTooLarge: () => {
          toast.error(
            translate(
              'auto.components.editor.MonacoEditor.largePasteTooLarge',
              'Paste is too large.'
            )
          )
        }
      })
  )
}
