import React, { useMemo, useState } from 'react'
import type { CtrlTabOrderMode } from '../../../../shared/types'
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
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { KeybindingsFileActions } from './KeybindingsFileActions'
import { SearchableSetting } from './SearchableSetting'
import { ShortcutBindingRow, type ShortcutTerminalStatus } from './ShortcutBindingRow'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

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

const CTRL_TAB_BEHAVIOR_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Recent Tab Order',
  description: 'Choose recent or sequential tab switching.',
  keywords: ['shortcut', 'tab', 'ctrl', 'control', 'recent', 'mru', 'sequential', 'switch']
}

const TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Shortcuts in Terminal',
  description: 'Choose whether Orca or the focused terminal wins when shortcuts overlap.',
  keywords: [
    'shortcut',
    'keyboard',
    'terminal',
    'tui',
    'shell',
    'agent',
    'conflict',
    'orca first',
    'terminal first'
  ]
}

export const SHORTCUTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...KEYBINDING_DEFINITIONS.map((item) => ({
    title: item.title,
    description: `${item.group} shortcut`,
    keywords: [...item.searchKeywords]
  })),
  TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY,
  CTRL_TAB_BEHAVIOR_SEARCH_ENTRY
]

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
  const ctrlTabOrderMode = useAppStore((state) => state.settings?.ctrlTabOrderMode ?? 'mru')
  const terminalShortcutPolicy = useAppStore(
    (state) => state.settings?.terminalShortcutPolicy ?? 'orca-first'
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  const keybindings = useAppStore((state) => state.keybindings)
  const keybindingSnapshot = useAppStore((state) => state.keybindingSnapshot)
  const setKeybindingOverride = useAppStore((state) => state.setKeybindingOverride)
  const resetKeybindingOverride = useAppStore((state) => state.resetKeybindingOverride)
  const disableKeybindingAction = useAppStore((state) => state.disableKeybindingAction)
  const [errors, setErrors] = useState<Partial<Record<KeybindingActionId, string>>>({})
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)

  const groups = useMemo(groupDefinitions, [])
  const groupEntries = useMemo<Record<string, SettingsSearchEntry[]>>(
    () =>
      Object.fromEntries(
        groups.map((group) => [
          group.title,
          group.items.map((item) => ({
            title: item.title,
            description: `${group.title} shortcut`,
            keywords: [...item.searchKeywords]
          }))
        ])
      ),
    [groups]
  )
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
      setErrors((prev) => ({
        ...prev,
        [actionId]: error instanceof Error ? error.message : 'Failed to save shortcut.'
      }))
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
    if (await saveBindings(actionId, [captured.value])) {
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
      setErrors((prev) => ({
        ...prev,
        [actionId]: error instanceof Error ? error.message : 'Failed to reset shortcut.'
      }))
    }
  }

  const disableBinding = async (actionId: KeybindingActionId): Promise<void> => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      await disableKeybindingAction(actionId)
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [actionId]: error instanceof Error ? error.message : 'Failed to disable shortcut.'
      }))
    }
  }

  const clearError = (actionId: KeybindingActionId): void => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
          <p className="text-xs text-muted-foreground">
            Customize shortcuts visually or edit the file directly.
          </p>
        </div>

        {matchesSettingsSearch(searchQuery, TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY) ? (
          <SearchableSetting
            id="terminal-shortcut-policy"
            title="Shortcuts in Terminal"
            description="Choose whether Orca or the focused terminal wins when shortcuts overlap."
            keywords={TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY.keywords}
            className="flex items-center justify-between gap-4 px-1 py-2"
          >
            <div className="space-y-0.5">
              <Label>Shortcuts in Terminal</Label>
              <p className="text-xs text-muted-foreground">
                Orca first keeps app shortcuts active in TUIs. Terminal first lets shell shortcuts
                win unless a shortcut is marked terminal-active.
              </p>
            </div>
            <Select
              value={terminalShortcutPolicy}
              onValueChange={(value) =>
                void updateSettings({
                  terminalShortcutPolicy: value as TerminalShortcutPolicy
                })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="orca-first">Orca first</SelectItem>
                <SelectItem value="terminal-first">Terminal first</SelectItem>
              </SelectContent>
            </Select>
          </SearchableSetting>
        ) : null}

        {matchesSettingsSearch(searchQuery, CTRL_TAB_BEHAVIOR_SEARCH_ENTRY) ? (
          <SearchableSetting
            title="Recent Tab Order"
            description="Choose recent or sequential tab switching."
            keywords={CTRL_TAB_BEHAVIOR_SEARCH_ENTRY.keywords}
            className="flex items-center justify-between gap-4 px-1 py-2"
          >
            <div className="space-y-0.5">
              <Label>Recent Tab Order</Label>
              <p className="text-xs text-muted-foreground">
                Choose whether recent tab switching follows recent use or the tab strip order.
              </p>
            </div>
            <Select
              value={ctrlTabOrderMode}
              onValueChange={(value) =>
                void updateSettings({ ctrlTabOrderMode: value as CtrlTabOrderMode })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mru">Most recent</SelectItem>
                <SelectItem value="sequential">Tab strip order</SelectItem>
              </SelectContent>
            </Select>
          </SearchableSetting>
        ) : null}

        <KeybindingsFileActions />

        <div className="grid gap-8">
          {groups
            .filter((group) => matchesSettingsSearch(searchQuery, groupEntries[group.title] ?? []))
            .map((group) => (
              <div key={group.title} className="space-y-3">
                <h3 className="border-b border-border/50 pb-2 text-sm font-medium text-muted-foreground">
                  {group.title}
                </h3>
                <div className="grid gap-2">
                  {group.items.map((item) => {
                    const effective = getEffectiveKeybindingsForAction(
                      item.id,
                      platform,
                      keybindings
                    )
                    const modified = hasOwnBindingOverride(keybindings, item.id)
                    const warnings = conflictByAction.get(item.id) ?? []
                    const terminalStatus = getShortcutTerminalStatus(
                      item,
                      terminalShortcutPolicy,
                      effective.length > 0
                    )

                    return (
                      <ShortcutBindingRow
                        key={item.id}
                        item={item}
                        groupTitle={group.title}
                        platform={platform}
                        effective={effective}
                        modified={modified}
                        error={errors[item.id]}
                        warnings={warnings}
                        recording={recordingActionId === item.id}
                        terminalStatus={terminalStatus}
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
                    )
                  })}
                </div>
              </div>
            ))}
        </div>
      </section>
    </div>
  )
}
