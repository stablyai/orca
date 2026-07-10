import type { KeybindingActionId } from '../../../../shared/keybindings'

export function clearRecordingActionForShortcutMutation(
  recordingActionId: KeybindingActionId | null,
  actionId: KeybindingActionId
): KeybindingActionId | null {
  return recordingActionId === actionId ? null : recordingActionId
}
