import type { KeybindingActionId } from '../../../../../shared/keybindings/types'
import { useAppStore } from '../../../store/index'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from '../../editor/autosave/editor-autosave'
import { getEditorCmdSaveFileId } from '../../editor/save/commands/editor-cmd-save-target'
import { runAfterEditorFramesFlush } from '../../editor/save/flush/editor-pending-flush'
import { canToggleChangesModeForFile } from '../../editor/view-mode/editor-panel-file-mode'
import { isEventTargetInsideFloatingWorkspacePanel } from '@/components/floating-terminal/workspace/floating-workspace-terminal-actions'

type EditorShortcutContext = {
  event: KeyboardEvent
  floatingWorkspaceFocused: boolean
  matchShortcut: (actionId: KeybindingActionId) => boolean
  notifyTerminalCapture: (actionId: KeybindingActionId) => void
}

// Return false for unclaimed chords so remaining workspace shortcuts can handle them.
export function handleTerminalWorkspaceEditorShortcut({
  event,
  floatingWorkspaceFocused,
  matchShortcut,
  notifyTerminalCapture
}: EditorShortcutContext): boolean {
  const floatingPanelOwnsEvent = (): boolean =>
    isEventTargetInsideFloatingWorkspacePanel(event.target) || floatingWorkspaceFocused
  // Save fallback for focus outside the editor; editor-local handlers own focused saves.
  if (!event.repeat && matchShortcut('editor.save')) {
    const target = event.target as HTMLElement | null
    const inEditor =
      target?.closest('.monaco-editor, [contenteditable]') !== null ||
      target?.closest('textarea:not(.xterm-helper-textarea), input') !== null
    if (!inEditor) {
      const state = useAppStore.getState()
      const requestedFileId = getEditorCmdSaveFileId(state, floatingPanelOwnsEvent())
      if (requestedFileId) {
        event.preventDefault()
        notifyTerminalCapture('editor.save')
        window.dispatchEvent(
          new CustomEvent<EditorRequestCmdSaveDetail>(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, {
            detail: { fileId: requestedFileId }
          })
        )
        return true
      }
    }
  }
  // Why: long/structured files need a discoverable unwrap path without Settings (#9974).
  if (!event.repeat && matchShortcut('editor.toggleWordWrap')) {
    const state = useAppStore.getState()
    if (state.activeTabType === 'editor' && state.activeFileId) {
      event.preventDefault()
      notifyTerminalCapture('editor.toggleWordWrap')
      // Why: diff surfaces use diffWordWrap; plain editors use editorWordWrap (#10086).
      const activeFile = state.openFiles.find((file) => file.id === state.activeFileId)
      if (activeFile?.mode === 'diff') {
        const wrapOn = state.settings?.diffWordWrap === true
        void state.updateSettings({ diffWordWrap: !wrapOn })
      } else {
        const wrapOn = state.settings?.editorWordWrap !== false
        void state.updateSettings({ editorWordWrap: !wrapOn })
      }
      return true
    }
  }
  // Why: keyboard path for the toolbar's Edit/Changes toggle (#11095).
  if (matchShortcut('editor.toggleChangesView')) {
    const state = useAppStore.getState()
    const fileId = getEditorCmdSaveFileId(state, floatingPanelOwnsEvent())
    const file = fileId ? state.openFiles.find((candidate) => candidate.id === fileId) : undefined
    if (file && canToggleChangesModeForFile(file)) {
      // Why: Monaco ignores defaultPrevented, so a chord like Mod+Z would also run its own command.
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) {
        notifyTerminalCapture('editor.toggleChangesView')
        const nextMode = state.editorViewMode[file.id] === 'changes' ? 'edit' : 'changes'
        // Why: leaving a custom editor unmounts its frame, which may still hold debounced edits.
        runAfterEditorFramesFlush(state, [file.id], () =>
          state.setEditorViewMode(file.id, nextMode)
        )
      }
      return true
    }
  }
  return false
}
