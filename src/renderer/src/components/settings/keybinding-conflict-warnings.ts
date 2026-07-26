import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingDefinition,
  type KeybindingActionId,
  type KeybindingFileSnapshot
} from '../../../../shared/keybindings'
import { getFileBindingOverrides, hasOwnBindingOverride } from './keybinding-override-edits'

/**
 * Per-action conflict warnings for the Shortcuts pane.
 *
 * Why: judged against the file's bindings, not the active ones. The loader
 * strips a conflicting override before it reaches the store, so judging the
 * active map always reports zero and leaves the stripped binding unexplained.
 */
export function buildKeybindingConflictWarnings(
  snapshot: KeybindingFileSnapshot | null,
  platform: NodeJS.Platform,
  ignoredActionIds: readonly KeybindingActionId[]
): Map<KeybindingActionId, string[]> {
  const warnings = new Map<KeybindingActionId, string[]>()
  const fileOverrides = getFileBindingOverrides(snapshot, platform)
  for (const conflict of findKeybindingConflicts(platform, fileOverrides, { ignoredActionIds })) {
    for (const actionId of conflict.actionIds) {
      // Why: only the custom binding is dropped. The other claimant keeps working
      // on its own binding, so warning on its row would blame an untouched action.
      if (!hasOwnBindingOverride(fileOverrides, actionId)) {
        continue
      }
      // Why: name only the other claimants — listing the row's own action reads
      // as if the shortcut conflicts with itself.
      const others = conflict.actionIds
        .filter((id) => id !== actionId)
        .map((id) => getKeybindingDefinition(id)?.title ?? id)
        .join(', ')
      warnings.set(actionId, [
        ...(warnings.get(actionId) ?? []),
        `${formatKeybindingList([conflict.binding], platform)} was ignored — it conflicts with ${others}.`
      ])
    }
  }
  return warnings
}
