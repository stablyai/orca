import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
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
import { EMPTY_DISABLED_TUI_AGENTS } from './shortcut-groups'
import { useAppStore } from '../../../store/index'
import { KeybindingsFileActions } from './KeybindingsFileActions'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import {
  hasCommonBindingOverride,
  removeBindingOverride,
  sameBindings
} from './keybinding-override-edits'
import { ShortcutFilterRail } from './ShortcutFilterRail'
import type { ShortcutFilter } from './ShortcutFilterRail'
import { ShortcutRowsList } from './ShortcutRowsList'
import { ShortcutTerminalPolicyControl } from './ShortcutTerminalPolicyControl'
import { getTerminalShortcutPolicySearchEntry } from './shortcuts-search'
import { matchesSettingsSearch } from '../search/settings-search'
import { clearRecordingActionForShortcutMutation } from './shortcut-recording-state'
import {
  adjustRecordingIndexAfterRemove,
  appendBinding,
  removeBindingAt,
  replaceBindingAt
} from './shortcut-binding-list-mutations'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { useEditablePluginCommands } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { buildShortcutDefinitionCatalog } from './shortcut-definition-catalog'
import { getClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import { buildShortcutRowVisibility } from './shortcut-row-visibility'
import { useMacCapturedDigitChords } from './use-mac-captured-digit-chords'
import { keybindingValidationErrorText } from './keybinding-diagnostic-text'
import { KeybindingFileDiagnostics } from './KeybindingFileDiagnostics'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import type {
  KeybindingActionId,
  KeybindingDefinition,
  KeybindingInput
} from '../../../../../shared/keybindings/types'

const isMac = navigator.userAgent.includes('Mac')
const platform: NodeJS.Platform = isMac
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux'

export function ShortcutsPane(): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const terminalShortcutPolicy = useAppStore(
    (state) => state.settings?.terminalShortcutPolicy ?? 'orca-first'
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  const keybindings = useAppStore((state) => state.keybindings)
  const keybindingSnapshot = useAppStore((state) => state.keybindingSnapshot)
  const disabledTuiAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? EMPTY_DISABLED_TUI_AGENTS
  )
  const setKeybindingOverride = useAppStore((state) => state.setKeybindingOverride)
  const resetKeybindingOverride = useAppStore((state) => state.resetKeybindingOverride)
  const disableKeybindingAction = useAppStore((state) => state.disableKeybindingAction)
  const pluginCommands = useEditablePluginCommands()
  const [managedBrowserCreationEnabled, mobileEmulatorCreationEnabled] = useAppStore(
    useShallow((state) => {
      const policy = getClientCreationActionPolicy(state, state.activeWorktreeId)
      return [
        policy['managed-browser'].state === 'enabled',
        policy['mobile-emulator'].state === 'enabled'
      ] as const
    })
  )
  const agentDashboardEnabled = useAppStore(
    (state) => state.settings?.experimentalAgentDashboardPopout === true
  )
  const mountedRef = useMountedRef()
  const [errors, setErrors] = useState<Partial<Record<KeybindingActionId, string>>>({})
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)
  const [recordingBindingIndex, setRecordingBindingIndex] = useState<number | null>(null)
  const [disableMemory, setDisableMemory] = useState<Partial<Record<KeybindingActionId, string[]>>>(
    {}
  )
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [shortcutFilter, setShortcutFilter] = useState<ShortcutFilter>('all')
  const macCapturedDigitChords = useMacCapturedDigitChords({ enabled: isMac })
  const missionControlConflictMessage = t(
    'auto.components.settings.shortcutDefinitionCatalog.missionControlConflict',
    'Blocked by Mission Control. Remap here or change it in System Settings.'
  )

  // Suspend global shortcuts so recorded chords reach the editor.
  useEffect(() => {
    window.api.ui.setShortcutRecorderFocused(recordingActionId !== null)
    return () => window.api.ui.setShortcutRecorderFocused(false)
  }, [recordingActionId])

  const { groups, definitions, definitionsByAction, ignoredConflictActionIds, conflictByAction } =
    useMemo(
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
        pluginCommands,
        t
      ]
    )
  const definitionForAction = (actionId: KeybindingActionId): KeybindingDefinition | null =>
    definitionsByAction.get(actionId) ?? getKeybindingDefinition(actionId)
  const effectiveBindingsForAction = (
    actionId: KeybindingActionId,
    overrides = keybindings
  ): string[] => {
    const definition = definitionForAction(actionId)
    return definition ? getEffectiveKeybindingsForDefinition(definition, platform, overrides) : []
  }
  const { filterCounts, shortcutRows, visibleShortcutCount, visibleShortcutGroups } = useMemo(
    () =>
      buildShortcutRowVisibility(
        {
          groups,
          keybindings,
          conflictByAction,
          terminalShortcutPolicy,
          platform,
          managedBrowserCreationEnabled,
          mobileEmulatorCreationEnabled,
          agentDashboardEnabled,
          settingsSearchQuery: searchQuery,
          shortcutQuery,
          shortcutFilter
        },
        t
      ),
    [
      agentDashboardEnabled,
      conflictByAction,
      groups,
      keybindings,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      searchQuery,
      shortcutFilter,
      shortcutQuery,
      t,
      terminalShortcutPolicy
    ]
  )

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

  const captureBinding = async (
    actionId: KeybindingActionId,
    input: KeybindingInput
  ): Promise<void> => {
    const captured = keybindingFromInputForAction(actionId, input, platform)
    if (!captured.ok) {
      setErrors((prev) => ({ ...prev, [actionId]: keybindingValidationErrorText(captured) }))
      return
    }

    const current = effectiveBindingsForAction(actionId)
    const next =
      recordingBindingIndex === null || recordingBindingIndex >= current.length
        ? appendBinding(current, captured.value)
        : replaceBindingAt(current, recordingBindingIndex, captured.value)
    if ((await saveBindings(actionId, next)) && mountedRef.current) {
      setRecordingActionId(null)
      setRecordingBindingIndex(null)
    }
  }

  const removeBinding = async (actionId: KeybindingActionId, index: number): Promise<void> => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    const current = effectiveBindingsForAction(actionId)
    await saveBindings(actionId, removeBindingAt(current, index))
  }

  const resetBinding = async (actionId: KeybindingActionId): Promise<void> => {
    await saveBindings(actionId, effectiveBindingsForAction(actionId, {}))
  }

  const disableBinding = async (actionId: KeybindingActionId): Promise<void> => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      await disableKeybindingAction(actionId)
    } catch (error) {
      if (mountedRef.current) {
        setErrors((prev) => ({
          ...prev,
          [actionId]: error instanceof Error ? error.message : 'Failed to disable shortcut.'
        }))
      }
    }
  }

  const clearError = (actionId: KeybindingActionId): void => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
  }

  const clearRecordingForAction = (actionId: KeybindingActionId): void => {
    if (recordingActionId === actionId) {
      setRecordingBindingIndex(null)
    }
    setRecordingActionId((current) => clearRecordingActionForShortcutMutation(current, actionId))
  }

  const showPolicy = matchesSettingsSearch(searchQuery, getTerminalShortcutPolicySearchEntry())

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden">
      <section className="flex min-h-0 flex-1 flex-col space-y-3">
        {showPolicy ? (
          <SettingsGroup>
            <ShortcutTerminalPolicyControl
              terminalShortcutPolicy={terminalShortcutPolicy}
              keywords={getTerminalShortcutPolicySearchEntry().keywords}
              updateSettings={updateSettings}
            />
          </SettingsGroup>
        ) : null}

        <SettingsSubsectionHeader
          title={t('auto.components.settings.ShortcutsPane.9a3a3ca03d', 'Keyboard shortcuts')}
          description={
            <>
              {t(
                'auto.components.settings.ShortcutsPane.38e86e206a',
                'Customize shortcuts visually or edit'
              )}{' '}
              <span className="font-mono text-[11px]">
                {keybindingSnapshot?.path ??
                  t(
                    'auto.components.settings.ShortcutsPane.d8c988dab4',
                    '~/.orca/keybindings.json'
                  )}
              </span>{' '}
              {t('auto.components.settings.ShortcutsPane.4b7ae34062', 'directly.')}
            </>
          }
          action={<KeybindingsFileActions />}
        />

        <KeybindingFileDiagnostics diagnostics={keybindingSnapshot?.diagnostics ?? []} />

        {/* Below xl, give the rail only content height and the list the remaining space; equal auto rows can overlap. */}
        <div className="grid min-h-0 flex-1 gap-6 max-xl:grid-rows-[auto_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)]">
          <ShortcutFilterRail
            query={shortcutQuery}
            onQueryChange={setShortcutQuery}
            filter={shortcutFilter}
            onFilterChange={setShortcutFilter}
            filterCounts={filterCounts}
            visibleCount={visibleShortcutCount}
            totalCount={shortcutRows.length}
          />

          <ShortcutRowsList
            // Hide overflow-x to avoid a phantom horizontal scrollbar from overflow-y-auto.
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-1 scrollbar-sleek"
            groups={visibleShortcutGroups}
            platform={platform}
            errors={errors}
            disableMemory={disableMemory}
            recordingActionId={recordingActionId}
            recordingBindingIndex={recordingBindingIndex}
            onStartRecordingAt={(actionId, index) => {
              setRecordingActionId(actionId)
              setRecordingBindingIndex(index)
              clearError(actionId)
            }}
            onAppendBinding={(actionId) => {
              const current = effectiveBindingsForAction(actionId)
              setRecordingActionId(actionId)
              setRecordingBindingIndex(current.length)
              clearError(actionId)
            }}
            onCancelRecording={() => {
              setRecordingActionId(null)
              setRecordingBindingIndex(null)
            }}
            onCapture={(actionId, input) => void captureBinding(actionId, input)}
            onClearError={clearError}
            onRemoveBindingAt={(actionId, index) => {
              // Adjust pending capture after removal shifts slots, or clear it if its row was removed.
              if (recordingActionId === actionId) {
                const nextIndex = adjustRecordingIndexAfterRemove(recordingBindingIndex, index)
                setRecordingBindingIndex(nextIndex)
                if (nextIndex === null) {
                  setRecordingActionId(null)
                }
              }
              void removeBinding(actionId, index)
            }}
            onResetAction={(actionId) => {
              clearRecordingForAction(actionId)
              void resetBinding(actionId)
            }}
            onDisableAction={(actionId) => {
              const current = effectiveBindingsForAction(actionId)
              setDisableMemory((memory) => ({ ...memory, [actionId]: current }))
              clearRecordingForAction(actionId)
              void disableBinding(actionId)
            }}
            onEnableAction={(actionId) => {
              const remembered = disableMemory[actionId]
              if (remembered && remembered.length > 0) {
                void saveBindings(actionId, remembered)
              }
            }}
          />
        </div>
      </section>
    </div>
  )
}
