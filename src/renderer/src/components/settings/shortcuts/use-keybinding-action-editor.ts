import { useMemo, useState } from 'react'
import {
  findKeybindingConflictsForDefinitions,
  formatKeybindingList
} from '../../../../../shared/keybindings/formatting'
import { getEffectiveKeybindingsForDefinition } from '../../../../../shared/keybindings/effective'
import { getKeybindingDefinition } from '../../../../../shared/keybindings/definitions'
import {
  getKeybindingResetBindings,
  resolveKeybindingOverrides
} from '../../../../../shared/keybindings/profile-defaults'
import { keybindingFromInputForAction } from '../../../../../shared/keybindings/input'
import { normalizeKeybindingListForAction } from '../../../../../shared/keybindings/normalization'
import type {
  KeybindingActionId,
  KeybindingDefinition,
  KeybindingInput,
  KeybindingOverrides
} from '../../../../../shared/keybindings/types'
import { useAppStore } from '../../../store/index'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { useEditablePluginCommands } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { EMPTY_DISABLED_TUI_AGENTS } from './shortcut-groups'
import { buildShortcutDefinitionCatalog } from './shortcut-definition-catalog'
import { useMacCapturedDigitChords } from './use-mac-captured-digit-chords'
import { keybindingValidationErrorText } from './keybinding-diagnostic-text'
import {
  hasCommonBindingOverride,
  removeBindingOverride,
  sameBindings
} from './keybinding-override-edits'
import { appendBinding, replaceBindingAt } from './shortcut-binding-list-mutations'

const isMac = navigator.userAgent.includes('Mac')
const SHORTCUT_EDITOR_PLATFORM: NodeJS.Platform = isMac
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux'

type KeybindingActionErrors = Partial<Record<KeybindingActionId, string>>

/** Validates, conflict-checks, and persists shortcut edits the same way wherever they are recorded. */
export function useKeybindingActionEditor() {
  const t = useTranslate()
  const platform = SHORTCUT_EDITOR_PLATFORM
  const keybindings = useAppStore((state) => state.keybindings)
  const keybindingSnapshot = useAppStore((state) => state.keybindingSnapshot)
  const disabledTuiAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? EMPTY_DISABLED_TUI_AGENTS
  )
  const setKeybindingOverride = useAppStore((state) => state.setKeybindingOverride)
  const resetKeybindingOverride = useAppStore((state) => state.resetKeybindingOverride)
  const pluginCommands = useEditablePluginCommands()
  const mountedRef = useMountedRef()
  const [errors, setErrors] = useState<KeybindingActionErrors>({})
  const macCapturedDigitChords = useMacCapturedDigitChords({ enabled: isMac })
  const missionControlConflictMessage = t(
    'auto.components.settings.shortcutDefinitionCatalog.missionControlConflict',
    'Blocked by Mission Control. Remap here or change it in System Settings.'
  )

  const catalog = useMemo(
    () =>
      buildShortcutDefinitionCatalog(
        {
          disabledTuiAgents,
          pluginCommands,
          keybindings,
          platform,
          macCapturedDigitChords,
          missionControlConflictMessage
        },
        t
      ),
    [
      disabledTuiAgents,
      keybindings,
      macCapturedDigitChords,
      missionControlConflictMessage,
      platform,
      pluginCommands,
      t
    ]
  )
  const { definitions, definitionsByAction, ignoredConflictActionIds } = catalog

  const definitionForAction = (actionId: KeybindingActionId): KeybindingDefinition | null =>
    definitionsByAction.get(actionId) ?? getKeybindingDefinition(actionId)
  const effectiveBindingsForAction = (
    actionId: KeybindingActionId,
    overrides: KeybindingOverrides = keybindings
  ): string[] => {
    const definition = definitionForAction(actionId)
    return definition ? getEffectiveKeybindingsForDefinition(definition, platform, overrides) : []
  }

  const saveBindings = async (
    actionId: KeybindingActionId,
    normalized: string[]
  ): Promise<boolean> => {
    const normalizedResult = normalizeKeybindingListForAction(actionId, normalized.join(', '))
    if (!Array.isArray(normalizedResult)) {
      setErrors((prev) => ({
        ...prev,
        [actionId]: normalizedResult.ok
          ? t('settings.shortcuts.parseFailed', 'Unable to parse shortcut.')
          : keybindingValidationErrorText(normalizedResult)
      }))
      return false
    }

    const definition = definitionForAction(actionId)
    if (!definition) {
      setErrors((prev) => ({
        ...prev,
        [actionId]: t(
          'auto.components.settings.ShortcutsPane.shortcutUnavailable',
          'Shortcut is no longer available.'
        )
      }))
      return false
    }
    const defaults = getEffectiveKeybindingsForDefinition(definition, platform, {})
    const explicitOverrides = keybindingSnapshot?.defaultOverrides
      ? { ...keybindingSnapshot.commonOverrides, ...keybindingSnapshot.platformOverrides[platform] }
      : keybindings
    const shouldReset =
      sameBindings(normalizedResult, defaults) &&
      !hasCommonBindingOverride(keybindingSnapshot, actionId)
    const nextBindings = shouldReset
      ? getKeybindingResetBindings(actionId, platform, keybindingSnapshot?.commonOverrides ?? {})
      : normalizedResult
    const next =
      nextBindings === null
        ? removeBindingOverride(explicitOverrides, actionId)
        : { ...explicitOverrides, [actionId]: nextBindings }
    const blockingConflict = findKeybindingConflictsForDefinitions(
      definitions,
      platform,
      resolveKeybindingOverrides(platform, next, keybindingSnapshot?.defaultOverrides ?? {}),
      {
        ignoredActionIds: ignoredConflictActionIds,
        includeMainProcessInterception: true
      }
    ).find((conflict) => conflict.actionIds.includes(actionId))
    if (blockingConflict) {
      const labels = blockingConflict.actionIds
        .filter((id) => id !== actionId)
        .map((id) => definitionsByAction.get(id)?.title ?? id)
        .join(', ')
      setErrors((prev) => ({
        ...prev,
        [actionId]: t(
          'auto.components.settings.shortcutDefinitionCatalog.bindingConflict',
          '{{binding}} conflicts with {{actions}}.',
          { binding: formatKeybindingList([blockingConflict.binding], platform), actions: labels }
        )
      }))
      return false
    }

    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      await (shouldReset
        ? resetKeybindingOverride(actionId)
        : setKeybindingOverride(actionId, normalizedResult))
      return true
    } catch (error) {
      if (mountedRef.current) {
        setErrors((prev) => ({
          ...prev,
          [actionId]: error instanceof Error ? error.message : 'Failed to save shortcut.'
        }))
      }
      return false
    }
  }

  /** Records `input` into `bindingIndex` (appending past the end); true once saved and still mounted. */
  const captureBinding = async (
    actionId: KeybindingActionId,
    input: KeybindingInput,
    bindingIndex: number | null
  ): Promise<boolean> => {
    const captured = keybindingFromInputForAction(actionId, input, platform)
    if (!captured.ok) {
      setErrors((prev) => ({ ...prev, [actionId]: keybindingValidationErrorText(captured) }))
      return false
    }
    const current = effectiveBindingsForAction(actionId)
    const next =
      bindingIndex === null || bindingIndex >= current.length
        ? appendBinding(current, captured.value)
        : replaceBindingAt(current, bindingIndex, captured.value)
    return (await saveBindings(actionId, next)) && mountedRef.current
  }

  const clearError = (actionId: KeybindingActionId): void => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
  }
  const clearErrors = (): void => setErrors({})

  return {
    platform,
    catalog,
    keybindings,
    keybindingSnapshot,
    errors,
    setErrors,
    clearError,
    clearErrors,
    mountedRef,
    effectiveBindingsForAction,
    saveBindings,
    captureBinding
  }
}
