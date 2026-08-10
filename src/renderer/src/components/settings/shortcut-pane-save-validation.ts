import {
  findKeybindingConflictsForDefinitions,
  formatKeybindingList,
  getEffectiveKeybindingsForDefinition,
  normalizeKeybindingListForAction,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'
import {
  translateKeybindingValidationError,
  translateShortcutConflictActionTitles,
  translateShortcutConflictWarning
} from './shortcut-action-copy'
import { removeBindingOverride, sameBindings } from './keybinding-override-edits'

export function validateShortcutBindingsToSave(args: {
  actionId: KeybindingActionId
  normalized: string[]
  definition: KeybindingDefinition | undefined
  definitions: readonly KeybindingDefinition[]
  definitionsByAction: ReadonlyMap<string, KeybindingDefinition>
  keybindings: KeybindingOverrides
  platform: NodeJS.Platform
  ignoredConflictActionIds: ReadonlySet<KeybindingActionId>
}): { ok: true; bindings: string[]; defaults: string[] } | { ok: false; error: string } {
  const normalizedResult = normalizeKeybindingListForAction(
    args.actionId,
    args.normalized.join(', ')
  )
  if (!Array.isArray(normalizedResult)) {
    return {
      ok: false,
      error: normalizedResult.ok
        ? translate(
            'auto.components.settings.ShortcutsPane.parseFailed',
            'Unable to parse shortcut.'
          )
        : translateKeybindingValidationError(normalizedResult.error)
    }
  }
  if (!args.definition) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.ShortcutsPane.shortcutUnavailable',
        'Shortcut is no longer available.'
      )
    }
  }
  const defaults = getEffectiveKeybindingsForDefinition(args.definition, args.platform, {})
  const next =
    sameBindings(normalizedResult, defaults) ||
    (normalizedResult.length === 0 && defaults.length === 0)
      ? removeBindingOverride(args.keybindings, args.actionId)
      : { ...args.keybindings, [args.actionId]: normalizedResult }
  const blockingConflict = findKeybindingConflictsForDefinitions(
    args.definitions,
    args.platform,
    next,
    { ignoredActionIds: args.ignoredConflictActionIds }
  ).find((conflict) => conflict.actionIds.includes(args.actionId))
  if (blockingConflict) {
    return {
      ok: false,
      error: translateShortcutConflictWarning(
        formatKeybindingList([blockingConflict.binding], args.platform),
        translateShortcutConflictActionTitles(
          blockingConflict.actionIds,
          args.actionId,
          args.definitionsByAction
        )
      )
    }
  }
  return { ok: true, bindings: normalizedResult, defaults }
}
