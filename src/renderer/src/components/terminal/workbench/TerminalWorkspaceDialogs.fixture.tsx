import { defineFixture } from '../../../component-fixtures/component-fixture'
import { TerminalWorkspaceDialogs } from './TerminalWorkspaceDialogs'
import type { TerminalController } from './use-terminal-controller'

/** Only the save/draft dialog is open; the window-close dialog renders nothing while closed. */
function controller(saveDialogKind: 'dirty' | 'plugin-draft'): TerminalController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog reads only the save-dialog fields stubbed here.
  return {
    confirmNativeWindowClose: () => {},
    handleSaveDialogCancel: () => {},
    handleSaveDialogDiscard: () => {},
    handleSaveDialogSave: () => {},
    saveDialogFile: { relativePath: 'docs/notes.md' },
    saveDialogFileId: 'notes.md',
    saveDialogKind,
    setWindowCloseDialogOpen: () => {},
    windowCloseDialogKind: 'running',
    windowCloseDialogOpen: false
  } as unknown as TerminalController
}

export const unsavedChanges = defineFixture({
  width: 400,
  render: () => <TerminalWorkspaceDialogs controller={controller('dirty')} />
})

// A custom-editor frame kept edits a flush could not hand over: Return / Discard, no Save.
export const unsavedDraft = defineFixture({
  width: 400,
  render: () => <TerminalWorkspaceDialogs controller={controller('plugin-draft')} />
})
