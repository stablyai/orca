import React, { useMemo, useState } from 'react'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  isKeybindingAllowedInTerminal,
  isKeybindingPotentialTerminalConflict,
  keybindingFromInputForAction,
  keybindingIsActiveInContext,
  normalizeKeybindingListForAction,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingInput,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import {
  EMPTY_DISABLED_TUI_AGENTS,
  disabledAgentTabActionIds,
  groupDefinitions
} from './shortcut-groups'
import { useAppStore } from '../../store'
import { KeybindingsFileActions } from './KeybindingsFileActions'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import type { ShortcutTerminalStatus } from './ShortcutBindingRow'
import {
  getShortcutSearchEntry,
  matchesShortcutFilter,
  matchesShortcutLocalSearch,
  ShortcutFilterRail,
  type ShortcutFilter,
  type ShortcutRowsByGroup
} from './ShortcutFilterRail'
import { ShortcutRowsList } from './ShortcutRowsList'
import { ShortcutTerminalPolicyControl } from './ShortcutTerminalPolicyControl'
import { getTerminalShortcutPolicySearchEntry } from './shortcuts-search'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'
import { clearRecordingActionForShortcutMutation } from './shortcut-recording-state'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

const isMac = navigator.userAgent.includes('Mac')
const platform: NodeJS.Platform = isMac
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux'

function sameBindings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((binding, index) => binding === b[index])
}

function hasOwnBindingOverride(
  overrides: KeybindingOverrides,
  actionId: KeybindingActionId
): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, actionId)
}

function removeBindingOverride(
  overrides: KeybindingOverrides,
  actionId: KeybindingActionId
): KeybindingOverrides {
  const next = { ...overrides }
  delete next[actionId]
  return next
}

function hasCommonBindingOverride(
  snapshot: ReturnType<typeof useAppStore.getState>['keybindingSnapshot'],
  actionId: KeybindingActionId
): boolean {
  return hasOwnBindingOverride(snapshot?.commonOverrides ?? {}, actionId)
}

function getShortcutTerminalStatus(
  definition: KeybindingDefinition,
  terminalShortcutPolicy: TerminalShortcutPolicy,
  hasEffectiveBinding: boolean
): ShortcutTerminalStatus | undefined {
  if (!hasEffectiveBinding) {
    return undefined
  }
  if (definition.scope === 'terminal') {
    return {
      label: translate('auto.components.settings.ShortcutsPane.cb02e00202', 'Terminal'),
      description: translate(
        'auto.components.settings.ShortcutsPane.781cb74d22',
        'Runs from terminal panes.'
      )
    }
  }
  if (isKeybindingAllowedInTerminal(definition)) {
    return {
      label: translate('auto.components.settings.ShortcutsPane.25b0004fbf', 'Terminal active'),
      description: translate(
        'auto.components.settings.ShortcutsPane.3c0fac059a',
        'Still runs while a terminal has keyboard focus.'
      )
    }
  }
  if (!isKeybindingPotentialTerminalConflict(definition)) {
    return undefined
  }
  const activeInTerminal = keybindingIsActiveInContext(definition, {
    context: 'terminal',
    terminalShortcutPolicy
  })
  return activeInTerminal
    ? {
        label: translate('auto.components.settings.ShortcutsPane.2a0e8aeccf', 'Orca first'),
        description: translate(
          'auto.components.settings.ShortcutsPane.dfa8ff612f',
          'Also runs while a terminal or TUI has keyboard focus.'
        )
      }
    : {
        label: translate('auto.components.settings.ShortcutsPane.5c65d5db9d', 'Terminal first'),
        description: translate(
          'auto.components.settings.ShortcutsPane.f0b35b0b2e',
          'Disabled while a terminal or TUI has keyboard focus.'
        )
      }
}

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
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [shortcutFilter, setShortcutFilter] = useState<ShortcutFilter>('all')

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
  const shortcutSearchQuery = normalizeSettingsSearchQuery(shortcutQuery)
  const shortcutRows = shortcutGroups.flatMap((group) => group.rows)
  const baseVisibleRows = shortcutRows.filter(
    (row) =>
      matchesSettingsSearch(searchQuery, getShortcutSearchEntry(row)) &&
      matchesShortcutLocalSearch(row, shortcutSearchQuery, platform)
  )
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
        (row) =>
          matchesSettingsSearch(searchQuery, getShortcutSearchEntry(row)) &&
          matchesShortcutLocalSearch(row, shortcutSearchQuery, platform) &&
          matchesShortcutFilter(row, shortcutFilter)
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

    // Why: the visual editor records one chord at a time; users can still
    // manage multi-binding arrays directly in keybindings.json.
    if ((await saveBindings(actionId, [captured.value])) && mountedRef.current) {
      setRecordingActionId(null)
    }
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

        <div className="grid min-h-0 flex-1 gap-6 xl:grid-cols-[16rem_minmax(0,1fr)]">
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
            className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 scrollbar-sleek"
            groups={visibleShortcutGroups}
            platform={platform}
            errors={errors}
            recordingActionId={recordingActionId}
            onStartRecording={(actionId) => {
              setRecordingActionId(actionId)
              clearError(actionId)
            }}
            onCancelRecording={() => setRecordingActionId(null)}
            onCapture={(actionId, input) => void captureBinding(actionId, input)}
            onClearError={clearError}
            onDisable={(actionId) => {
              clearRecordingForAction(actionId)
              void disableBinding(actionId)
            }}
            onReset={(actionId) => {
              clearRecordingForAction(actionId)
              void resetBinding(actionId)
            }}
          />
        </div>
      </section>
    </div>
  )
}
