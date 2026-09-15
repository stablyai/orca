import type { KeybindingActionId } from '../../../shared/keybindings'
import { useAppStore } from '../store'
import {
  nextEditorTextDirectionOverride,
  resolveEditorTextDirection
} from '../../../shared/editor-text-direction'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from './editor/editor-autosave'
import { getEditorCmdSaveFileId } from './editor/editor-cmd-save-target'
import { isEventTargetInsideFloatingWorkspacePanel } from '@/lib/floating-workspace-terminal-actions'

type EditorShortcutContext = {
  event: KeyboardEvent
  floatingWorkspaceFocused: boolean
  matchShortcut: (actionId: KeybindingActionId) => boolean
  notifyTerminalCapture: (actionId: KeybindingActionId) => void
}

// Returns true only when the chord was consumed, so unclaimed editor chords still
// fall through to the remaining workspace shortcuts.
export function handleTerminalWorkspaceEditorShortcut({
  event,
  floatingWorkspaceFocused,
  matchShortcut,
  notifyTerminalCapture
}: EditorShortcutContext): boolean {
  // Save active editor file — fallback for when focus is outside the editor (tab bar/sidebar); editor-local handlers own save when the editor is focused.
  if (!event.repeat && matchShortcut('editor.save')) {
    const target = event.target as HTMLElement | null
    const inEditor =
      target?.closest('.monaco-editor, [contenteditable]') !== null ||
      target?.closest('textarea:not(.xterm-helper-textarea), input') !== null
    if (!inEditor) {
      const state = useAppStore.getState()
      const floatingPanelOwnsEvent =
        isEventTargetInsideFloatingWorkspacePanel(event.target) || floatingWorkspaceFocused
      const requestedFileId = getEditorCmdSaveFileId(state, floatingPanelOwnsEvent)
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
  // Why: RTL users need to flip direction without leaving the keyboard; unbound until assigned.
  if (!event.repeat && matchShortcut('editor.toggleTextDirection')) {
    const state = useAppStore.getState()
    if (state.activeTabType === 'editor' && state.activeFileId) {
      const activeFile = state.openFiles.find((file) => file.id === state.activeFileId)
      // Why: diff sub-editors keep Monaco's LTR-only layout math, matching the header affordance.
      if (activeFile?.mode === 'edit') {
        event.preventDefault()
        notifyTerminalCapture('editor.toggleTextDirection')
        const override = state.editorTextDirectionByFile[activeFile.id]
        // Why: mirrors the header button -- clear an existing override so the file can always
        // fall back to Settings, including an 'auto' default.
        state.setEditorTextDirectionOverride(
          activeFile.id,
          override
            ? null
            : nextEditorTextDirectionOverride(
                resolveEditorTextDirection(state.settings?.editorTextDirection, override)
              )
        )
        return true
      }
    }
  }
  return false
}
