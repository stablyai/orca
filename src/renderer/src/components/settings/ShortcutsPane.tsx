import React, { useEffect, useMemo, useState } from 'react'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  keybindingFromInputForAction,
  normalizeKeybindingListForAction,
  type KeybindingActionId,
  type KeybindingInput
} from '../../../../shared/keybindings'
import {
  EMPTY_DISABLED_TUI_AGENTS,
  disabledAgentTabActionIds,
  groupDefinitions
} from './shortcut-groups'
import { useAppStore } from '../../store'
import { KeybindingsFileActions } from './KeybindingsFileActions'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { getShortcutTerminalStatus } from './shortcut-terminal-status'
import {
  hasCommonBindingOverride,
  hasOwnBindingOverride,
  removeBindingOverride,
  sameBindings
} from './keybinding-override-edits'
import {
  buildShortcutGlobalSearchMatcher,
  matchesShortcutFilter,
  matchesShortcutLocalSearch,
  normalizeShortcutLocalSearchQuery,
  ShortcutFilterRail,
  type ShortcutFilter,
  type ShortcutRowsByGroup
} from './ShortcutFilterRail'
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

const isMac = navigator.userAgent.includes('Mac')
const platform: NodeJS.Platform = isMac
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux'

export function ShortcutsPane(): React.JSX.Element {
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
  const mountedRef = useMountedRef()
  const [errors, setErrors] = useState<Partial<Record<KeybindingActionId, string>>>({})
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)
  // Which binding index of the recording action is being captured. Equals the
  // effective length when capturing a brand-new (appended) binding.
  const [recordingBindingIndex, setRecordingBindingIndex] = useState<number | null>(null)
  // Bindings an action had right before it was disabled, so "Enable" can restore
  // them in one click instead of forcing a reset-to-default.
  const [disableMemory, setDisableMemory] = useState<Partial<Record<KeybindingActionId, string[]>>>(
    {}
  )
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [shortcutFilter, setShortcutFilter] = useState<ShortcutFilter>('all')

  // Why: tell the main process to suspend global shortcut dispatch while any row
  // is recording, so the captured chord lands in the editor instead of firing.
  // One source of truth here avoids races between per-row recorder effects.
  useEffect(() => {
    window.api.ui.setShortcutRecorderFocused(recordingActionId !== null)
    return () => window.api.ui.setShortcutRecorderFocused(false)
  }, [recordingActionId])

  const groups = useMemo(() => groupDefinitions(disabledTuiAgents), [disabledTuiAgents])
  const ignoredConflictActionIds = useMemo(
    () => disabledAgentTabActionIds(disabledTuiAgents),
    [disabledTuiAgents]
  )
  const conflictByAction = useMemo(() => {
    const result = new Map<KeybindingActionId, string[]>()
    for (const conflict of findKeybindingConflicts(platform, keybindings, {
      ignoredActionIds: ignoredConflictActionIds
    })) {
      const labels = conflict.actionIds
        .map((id) => getKeybindingDefinition(id)?.title ?? id)
        .join(', ')
      for (const actionId of conflict.actionIds) {
        result.set(actionId, [
          ...(result.get(actionId) ?? []),
          `${formatKeybindingList([conflict.binding], platform)} conflicts with ${labels}.`
        ])
      }
    }
    return result
  }, [ignoredConflictActionIds, keybindings])
  const shortcutGroups = useMemo<ShortcutRowsByGroup[]>(
    () =>
      groups.map((group) => ({
        title: group.title,
        rows: group.items.map((item) => {
          const effective = getEffectiveKeybindingsForAction(item.id, platform, keybindings)
          const modified = hasOwnBindingOverride(keybindings, item.id)
          const warnings = conflictByAction.get(item.id) ?? []
          return {
            item,
            groupTitle: group.title,
            effective,
            modified,
            warnings,
            terminalStatus: getShortcutTerminalStatus(
              item,
              terminalShortcutPolicy,
              effective.length > 0
            )
          }
        })
      })),
    [conflictByAction, groups, keybindings, terminalShortcutPolicy]
  )
  const shortcutSearchQuery = normalizeShortcutLocalSearchQuery(shortcutQuery)
  const shortcutRows = shortcutGroups.flatMap((group) => group.rows)
  const matchesShortcutGlobalSearch = buildShortcutGlobalSearchMatcher(shortcutRows, searchQuery)
  const matchesShortcutSearch = (row: ShortcutRowsByGroup['rows'][number]): boolean =>
    shortcutSearchQuery !== null &&
    matchesShortcutGlobalSearch(row) &&
    matchesShortcutLocalSearch(row, shortcutSearchQuery, platform)
  const baseVisibleRows = shortcutRows.filter((row) => matchesShortcutSearch(row))
  const filterCounts: Record<ShortcutFilter, number> = {
    all: baseVisibleRows.length,
    modified: baseVisibleRows.filter((row) => row.modified).length,
    unassigned: baseVisibleRows.filter((row) => row.effective.length === 0).length,
    conflicts: baseVisibleRows.filter((row) => row.warnings.length > 0).length
  }
  const visibleShortcutGroups = shortcutGroups
    .map((group) => ({
      title: group.title,
      rows: group.rows.filter(
        (row) => matchesShortcutSearch(row) && matchesShortcutFilter(row, shortcutFilter)
      )
    }))
    .filter((group) => group.rows.length > 0)
  const visibleShortcutCount = visibleShortcutGroups.reduce(
    (sum, group) => sum + group.rows.length,
    0
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

    const defaults = getEffectiveKeybindingsForAction(actionId, platform, {})
    const next =
      sameBindings(normalizedResult, defaults) ||
      (normalizedResult.length === 0 && defaults.length === 0)
        ? removeBindingOverride(keybindings, actionId)
        : { ...keybindings, [actionId]: normalizedResult }
    const blockingConflict = findKeybindingConflicts(platform, next, {
      ignoredActionIds: ignoredConflictActionIds
    }).find((conflict) => conflict.actionIds.includes(actionId))
    if (blockingConflict) {
      const labels = blockingConflict.actionIds
        .filter((id) => id !== actionId)
        .map((id) => getKeybindingDefinition(id)?.title ?? id)
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

    // Edit just the targeted binding (or append a new one) instead of replacing
    // the whole list, so an action's other bindings survive the capture.
    const current = getEffectiveKeybindingsForAction(actionId, platform, keybindings)
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
    const current = getEffectiveKeybindingsForAction(actionId, platform, keybindings)
    await saveBindings(actionId, removeBindingAt(current, index))
  }

  const resetBinding = async (actionId: KeybindingActionId): Promise<void> => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      await (hasCommonBindingOverride(keybindingSnapshot, actionId)
        ? setKeybindingOverride(actionId, getEffectiveKeybindingsForAction(actionId, platform, {}))
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
    // Why: disable/reset are final shortcut edits; the next keypress must not
    // be captured into the shortcut the user just removed or restored.
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
            // overflow-x-hidden is explicit: overflow-y-auto alone makes the
            // browser compute overflow-x to auto, which produced the phantom
            // horizontal scroll when long edit-time content popped in.
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
              const current = getEffectiveKeybindingsForAction(actionId, platform, keybindings)
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
              const current = getEffectiveKeybindingsForAction(actionId, platform, keybindings)
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
