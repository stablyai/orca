import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  findKeybindingConflictsForDefinitions,
  formatKeybindingList,
  getEffectiveKeybindingsForDefinition,
  getKeybindingDefinition,
  keybindingFromInputForAction,
  normalizeKeybindingListForAction,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingInput
} from '../../../../shared/keybindings'
import { EMPTY_DISABLED_TUI_AGENTS } from './shortcut-groups'
import { useAppStore } from '../../store'
import { KeybindingsFileActions } from './KeybindingsFileActions'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import {
  hasCommonBindingOverride,
  removeBindingOverride,
  sameBindings
} from './keybinding-override-edits'
import { ShortcutFilterRail, type ShortcutFilter } from './ShortcutFilterRail'
import { ShortcutRowsList } from './ShortcutRowsList'
import { ShortcutTerminalPolicyControl } from './ShortcutTerminalPolicyControl'
import { getTerminalShortcutPolicySearchEntry } from './shortcuts-search'
import { matchesSettingsSearch } from './settings-search'
import { clearRecordingActionForShortcutMutation } from './shortcut-recording-state'
import {
  adjustRecordingIndexAfterRemove,
  appendBinding,
  removeBindingAt,
  replaceBindingAt
} from './shortcut-binding-list-mutations'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useEditablePluginCommands } from '@/store/plugin-panels'
import { buildShortcutDefinitionCatalog } from './shortcut-definition-catalog'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { buildShortcutRowVisibility } from './shortcut-row-visibility'
import { useMacCapturedDigitChords } from './use-mac-captured-digit-chords'

const isMac = navigator.userAgent.includes('Mac')
const platform: NodeJS.Platform = isMac
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux'

export function ShortcutsPane(): React.JSX.Element {
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
  const mountedRef = useMountedRef()
  const [errors, setErrors] = useState<Partial<Record<KeybindingActionId, string>>>({})
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)
  // The effective length targets a new appended binding.
  const [recordingBindingIndex, setRecordingBindingIndex] = useState<number | null>(null)
  // Preserve disabled bindings so Enable can restore them.
  const [disableMemory, setDisableMemory] = useState<Partial<Record<KeybindingActionId, string[]>>>(
    {}
  )
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [shortcutFilter, setShortcutFilter] = useState<ShortcutFilter>('all')
  const macCapturedDigitChords = useMacCapturedDigitChords({ enabled: isMac })
  const missionControlConflictMessage = translate(
    'auto.components.settings.shortcutDefinitionCatalog.missionControlConflict',
    'Blocked by Mission Control. Remap here or change it in System Settings.'
  )

  // Why: suspend global dispatch so a captured chord reaches the editor.
  useEffect(() => {
    window.api.ui.setShortcutRecorderFocused(recordingActionId !== null)
    return () => window.api.ui.setShortcutRecorderFocused(false)
  }, [recordingActionId])

  const { groups, definitions, definitionsByAction, ignoredConflictActionIds, conflictByAction } =
    useMemo(
      () =>
        buildShortcutDefinitionCatalog({
          disabledTuiAgents,
          pluginCommands,
          keybindings,
          platform,
          macCapturedDigitChords,
          missionControlConflictMessage
        }),
      [
        disabledTuiAgents,
        keybindings,
        macCapturedDigitChords,
        missionControlConflictMessage,
        pluginCommands
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
      buildShortcutRowVisibility({
        groups,
        keybindings,
        conflictByAction,
        terminalShortcutPolicy,
        platform,
        managedBrowserCreationEnabled,
        mobileEmulatorCreationEnabled,
        settingsSearchQuery: searchQuery,
        shortcutQuery,
        shortcutFilter
      }),
    [
      conflictByAction,
      groups,
      keybindings,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      searchQuery,
      shortcutFilter,
      shortcutQuery,
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
        [actionId]: normalizedResult.ok ? 'Unable to parse shortcut.' : normalizedResult.error
      }))
      return false
    }

    const definition = definitionForAction(actionId)
    if (!definition) {
      setErrors((prev) => ({
        ...prev,
        [actionId]: translate(
          'auto.components.settings.ShortcutsPane.shortcutUnavailable',
          'Shortcut is no longer available.'
        )
      }))
      return false
    }
    const defaults = getEffectiveKeybindingsForDefinition(definition, platform, {})
    const next =
      sameBindings(normalizedResult, defaults) ||
      (normalizedResult.length === 0 && defaults.length === 0)
        ? removeBindingOverride(keybindings, actionId)
        : { ...keybindings, [actionId]: normalizedResult }
    const blockingConflict = findKeybindingConflictsForDefinitions(definitions, platform, next, {
      ignoredActionIds: ignoredConflictActionIds
    }).find((conflict) => conflict.actionIds.includes(actionId))
    if (blockingConflict) {
      const labels = blockingConflict.actionIds
        .filter((id) => id !== actionId)
        .map((id) => definitionsByAction.get(id)?.title ?? id)
        .join(', ')
      setErrors((prev) => ({
        ...prev,
        [actionId]: `${formatKeybindingList([blockingConflict.binding], platform)} conflicts with ${labels}.`
      }))
      return false
    }

    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      const matchesDefault =
        sameBindings(normalizedResult, defaults) ||
        (normalizedResult.length === 0 && defaults.length === 0)
      await (matchesDefault && !hasCommonBindingOverride(keybindingSnapshot, actionId)
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
      setErrors((prev) => ({ ...prev, [actionId]: captured.error }))
      return
    }

    // Preserve sibling bindings when editing or appending one chord.
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
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      await (hasCommonBindingOverride(keybindingSnapshot, actionId)
        ? setKeybindingOverride(actionId, effectiveBindingsForAction(actionId, {}))
        : resetKeybindingOverride(actionId))
    } catch (error) {
      if (mountedRef.current) {
        setErrors((prev) => ({
          ...prev,
          [actionId]: error instanceof Error ? error.message : 'Failed to reset shortcut.'
        }))
      }
    }
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
    // Why: final edits must not leave the recorder armed.
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
          <ShortcutTerminalPolicyControl
            terminalShortcutPolicy={terminalShortcutPolicy}
            keywords={getTerminalShortcutPolicySearchEntry().keywords}
            updateSettings={updateSettings}
          />
        ) : null}

        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.ShortcutsPane.47f8f7aef9',
            'Keyboard Shortcuts'
          )}
          description={
            <>
              {translate(
                'auto.components.settings.ShortcutsPane.38e86e206a',
                'Customize shortcuts visually or edit'
              )}{' '}
              <span className="font-mono text-[11px]">
                {keybindingSnapshot?.path ??
                  translate(
                    'auto.components.settings.ShortcutsPane.d8c988dab4',
                    '~/.orca/keybindings.json'
                  )}
              </span>{' '}
              {translate('auto.components.settings.ShortcutsPane.4b7ae34062', 'directly.')}
            </>
          }
          action={<KeybindingsFileActions />}
        />

        {keybindingSnapshot?.diagnostics.length ? (
          <div className="space-y-1">
            {keybindingSnapshot.diagnostics.map((diagnostic, index) => (
              <p
                key={`${diagnostic.section ?? 'root'}-${diagnostic.actionId ?? index}`}
                className={
                  diagnostic.severity === 'error'
                    ? 'text-xs text-destructive'
                    : 'text-xs text-muted-foreground'
                }
              >
                {diagnostic.message}
              </p>
            ))}
          </div>
        ) : null}

        {/* Below xl the rail stacks above the list in one column; pin the rail
            row to its content (auto) and let the list row take the rest, so the
            rail can't spill over the list the way two equal auto rows would. */}
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
            // Why: overflow-y-auto otherwise creates a phantom horizontal scrollbar.
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
              // Keep a pending capture aimed at the right row after the removal
              // shifts indices (or clear it if the recorded row itself is gone).
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
              // Remember the current bindings first so "Enable" can restore them.
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
