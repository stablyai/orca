import React, { useMemo, useState } from 'react'
import {
  KEYBINDING_DEFINITIONS,
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
  type ShortcutGroupSummary,
  type ShortcutRowsByGroup
} from './ShortcutFilterRail'
import { ShortcutRowsList } from './ShortcutRowsList'
import { ShortcutTerminalPolicyControl } from './ShortcutTerminalPolicyControl'
import { TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY } from './shortcuts-search'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'
import { useMountedRef } from '@/hooks/useMountedRef'

type ShortcutGroup = {
  title: string
  items: KeybindingDefinition[]
}

const isMac = navigator.userAgent.includes('Mac')
const platform: NodeJS.Platform = isMac
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux'

function groupDefinitions(): ShortcutGroup[] {
  const groups = new Map<string, KeybindingDefinition[]>()
  for (const definition of KEYBINDING_DEFINITIONS) {
    groups.set(definition.group, [...(groups.get(definition.group) ?? []), definition])
  }
  return Array.from(groups.entries()).map(([title, items]) => ({ title, items }))
}

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
      label: 'Terminal',
      description: 'Runs from terminal panes.'
    }
  }
  if (isKeybindingAllowedInTerminal(definition)) {
    return {
      label: 'Terminal active',
      description: 'Still runs while a terminal has keyboard focus.'
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
        label: 'Orca first',
        description: 'Also runs while a terminal or TUI has keyboard focus.'
      }
    : {
        label: 'Terminal first',
        description: 'Disabled while a terminal or TUI has keyboard focus.'
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
  const setKeybindingOverride = useAppStore((state) => state.setKeybindingOverride)
  const resetKeybindingOverride = useAppStore((state) => state.resetKeybindingOverride)
  const disableKeybindingAction = useAppStore((state) => state.disableKeybindingAction)
  const mountedRef = useMountedRef()
  const [errors, setErrors] = useState<Partial<Record<KeybindingActionId, string>>>({})
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [shortcutFilter, setShortcutFilter] = useState<ShortcutFilter>('all')
  const [activeShortcutGroup, setActiveShortcutGroup] = useState<string>('all')

  const groups = useMemo(groupDefinitions, [])
  const conflictByAction = useMemo(() => {
    const result = new Map<KeybindingActionId, string[]>()
    for (const conflict of findKeybindingConflicts(platform, keybindings)) {
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
  }, [keybindings])
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
  const groupSummaries: ShortcutGroupSummary[] = [
    {
      id: 'all',
      label: 'All shortcuts',
      count: baseVisibleRows.filter((row) => matchesShortcutFilter(row, shortcutFilter)).length
    },
    ...shortcutGroups.map((group) => ({
      id: group.title,
      label: group.title,
      count: group.rows.filter(
        (row) =>
          matchesSettingsSearch(searchQuery, getShortcutSearchEntry(row)) &&
          matchesShortcutLocalSearch(row, shortcutSearchQuery, platform) &&
          matchesShortcutFilter(row, shortcutFilter)
      ).length
    }))
  ]
  const visibleShortcutGroups = shortcutGroups
    .map((group) => ({
      title: group.title,
      rows: group.rows.filter(
        (row) =>
          (activeShortcutGroup === 'all' || row.groupTitle === activeShortcutGroup) &&
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
    const blockingConflict = findKeybindingConflicts(platform, next).find((conflict) =>
      conflict.actionIds.includes(actionId)
    )
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

  const showPolicy = matchesSettingsSearch(searchQuery, TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY)

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden">
      <section className="flex min-h-0 flex-1 flex-col space-y-3">
        <SettingsSubsectionHeader
          title="Keyboard Shortcuts"
          description="Customize shortcuts visually or edit the file directly."
        />

        <div className="grid min-h-0 flex-1 gap-6 xl:grid-cols-[16rem_minmax(0,1fr)]">
          <ShortcutFilterRail
            query={shortcutQuery}
            onQueryChange={setShortcutQuery}
            filter={shortcutFilter}
            onFilterChange={setShortcutFilter}
            activeGroup={activeShortcutGroup}
            onActiveGroupChange={setActiveShortcutGroup}
            filterCounts={filterCounts}
            groupSummaries={groupSummaries}
            visibleCount={visibleShortcutCount}
            totalCount={shortcutRows.length}
          />

          <div className="flex min-h-0 min-w-0 flex-col gap-5">
            {showPolicy ? (
              <ShortcutTerminalPolicyControl
                terminalShortcutPolicy={terminalShortcutPolicy}
                keywords={TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY.keywords}
                updateSettings={updateSettings}
              />
            ) : null}

            <KeybindingsFileActions />

            <ShortcutRowsList
              className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-sleek"
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
              onDisable={(actionId) => void disableBinding(actionId)}
              onReset={(actionId) => void resetBinding(actionId)}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
