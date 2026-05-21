import React, { useMemo, useState } from 'react'
import { FileText, FolderOpen, RefreshCw } from 'lucide-react'
import type { CtrlTabOrderMode } from '../../../../shared/types'
import {
  KEYBINDING_DEFINITIONS,
  findKeybindingConflicts,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  getKeybindingDefinition,
  normalizeKeybindingListForAction,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { ShortcutBindingRow } from './ShortcutBindingRow'
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

export const SHORTCUTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...KEYBINDING_DEFINITIONS.map((item) => ({
    title: item.title,
    description: `${item.group} shortcut`,
    keywords: [...item.searchKeywords]
  })),
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

function bindingInputValue(actionId: KeybindingActionId, overrides: KeybindingOverrides): string {
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).join(', ')
}

function hasCommonBindingOverride(
  snapshot: ReturnType<typeof useAppStore.getState>['keybindingSnapshot'],
  actionId: KeybindingActionId
): boolean {
  return hasOwnBindingOverride(snapshot?.commonOverrides ?? {}, actionId)
}

export function ShortcutsPane(): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const ctrlTabOrderMode = useAppStore((state) => state.settings?.ctrlTabOrderMode ?? 'mru')
  const updateSettings = useAppStore((state) => state.updateSettings)
  const keybindings = useAppStore((state) => state.keybindings)
  const keybindingSnapshot = useAppStore((state) => state.keybindingSnapshot)
  const setKeybindingOverride = useAppStore((state) => state.setKeybindingOverride)
  const resetKeybindingOverride = useAppStore((state) => state.resetKeybindingOverride)
  const disableKeybindingAction = useAppStore((state) => state.disableKeybindingAction)
  const reloadKeybindings = useAppStore((state) => state.reloadKeybindings)
  const openKeybindingsFile = useAppStore((state) => state.openKeybindingsFile)
  const revealKeybindingsFile = useAppStore((state) => state.revealKeybindingsFile)
  const [drafts, setDrafts] = useState<Partial<Record<KeybindingActionId, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<KeybindingActionId, string>>>({})

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

  const commitBinding = async (actionId: KeybindingActionId): Promise<void> => {
    const draft = drafts[actionId] ?? bindingInputValue(actionId, keybindings)
    const normalized = normalizeKeybindingListForAction(actionId, draft)
    if (!Array.isArray(normalized)) {
      setErrors((prev) => ({
        ...prev,
        [actionId]: normalized.ok ? 'Unable to parse shortcut.' : normalized.error
      }))
      return
    }

    const defaults = getEffectiveKeybindingsForAction(actionId, platform, {})
    const next =
      sameBindings(normalized, defaults) || (normalized.length === 0 && defaults.length === 0)
        ? removeBindingOverride(keybindings, actionId)
        : { ...keybindings, [actionId]: normalized }
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
      return
    }

    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      const matchesDefault =
        sameBindings(normalized, defaults) || (normalized.length === 0 && defaults.length === 0)
      await (matchesDefault && !hasCommonBindingOverride(keybindingSnapshot, actionId)
        ? resetKeybindingOverride(actionId)
        : setKeybindingOverride(actionId, normalized))
      setDrafts((prev) => ({ ...prev, [actionId]: normalized.join(', ') }))
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [actionId]: error instanceof Error ? error.message : 'Failed to save shortcut.'
      }))
    }
  }

  const resetBinding = async (actionId: KeybindingActionId): Promise<void> => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    setDrafts((prev) => ({ ...prev, [actionId]: undefined }))
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
    setDrafts((prev) => ({ ...prev, [actionId]: '' }))
    try {
      await disableKeybindingAction(actionId)
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [actionId]: error instanceof Error ? error.message : 'Failed to disable shortcut.'
      }))
    }
  }

  const setDraftValue = (actionId: KeybindingActionId, value: string): void => {
    setDrafts((prev) => ({ ...prev, [actionId]: value }))
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

        <div className="space-y-3 rounded-md border border-border bg-card p-3 text-card-foreground shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium">Keybindings File</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {keybindingSnapshot?.path ?? '~/.orca/keybindings.json'}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void openKeybindingsFile()}
              >
                <FileText className="size-3" />
                Open File
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void revealKeybindingsFile()}
              >
                <FolderOpen className="size-3" />
                Reveal
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void reloadKeybindings()}
              >
                <RefreshCw className="size-3" />
                Reload
              </Button>
            </div>
          </div>
          {keybindingSnapshot?.diagnostics.length ? (
            <div className="space-y-1 border-t border-border/50 pt-2">
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
        </div>

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
                    const draft = drafts[item.id] ?? effective.join(', ')
                    const modified = hasOwnBindingOverride(keybindings, item.id)
                    const warnings = conflictByAction.get(item.id) ?? []

                    return (
                      <ShortcutBindingRow
                        key={item.id}
                        item={item}
                        groupTitle={group.title}
                        platform={platform}
                        effective={effective}
                        draft={draft}
                        modified={modified}
                        error={errors[item.id]}
                        warnings={warnings}
                        onDraftChange={setDraftValue}
                        onClearError={clearError}
                        onCommit={(actionId) => void commitBinding(actionId)}
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
