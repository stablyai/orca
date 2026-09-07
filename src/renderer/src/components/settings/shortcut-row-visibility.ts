import {
  getEffectiveKeybindingsForDefinition,
  type KeybindingActionId,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import { hasOwnBindingOverride } from './keybinding-override-edits'
import type { ShortcutGroup } from './shortcut-groups'
import { getShortcutTerminalStatus } from './shortcut-terminal-status'
import {
  buildShortcutGlobalSearchMatcher,
  matchesShortcutFilter,
  matchesShortcutLocalSearch,
  normalizeShortcutLocalSearchQuery,
  type ShortcutFilter,
  type ShortcutRowsByGroup
} from './ShortcutFilterRail'

export function buildShortcutRowVisibility(options: {
  groups: ShortcutGroup[]
  keybindings: KeybindingOverrides
  conflictByAction: Map<KeybindingActionId, string[]>
  terminalShortcutPolicy: TerminalShortcutPolicy
  platform: NodeJS.Platform
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
  agentDashboardEnabled: boolean
  settingsSearchQuery: string
  shortcutQuery: string
  shortcutFilter: ShortcutFilter
}): {
  filterCounts: Record<ShortcutFilter, number>
  shortcutRows: ShortcutRowsByGroup['rows']
  visibleShortcutCount: number
  visibleShortcutGroups: ShortcutRowsByGroup[]
} {
  const shortcutGroups = options.groups.map((group) => ({
    title: group.title,
    rows: group.items
      .filter(
        (item) =>
          (options.managedBrowserCreationEnabled || item.id !== 'tab.newBrowser') &&
          (options.mobileEmulatorCreationEnabled || item.id !== 'tab.newSimulator') &&
          // Why: the toggle is inert while the experiment is off, so binding it here would silently do nothing.
          (options.agentDashboardEnabled || item.id !== 'dashboard.toggle')
      )
      .map((item) => {
        const effective = getEffectiveKeybindingsForDefinition(
          item,
          options.platform,
          options.keybindings
        )
        return {
          item,
          groupTitle: group.title,
          effective,
          modified: hasOwnBindingOverride(options.keybindings, item.id),
          warnings: options.conflictByAction.get(item.id) ?? [],
          terminalStatus: getShortcutTerminalStatus(
            item,
            options.terminalShortcutPolicy,
            effective.length > 0
          )
        }
      })
  }))
  const shortcutRows = shortcutGroups.flatMap((group) => group.rows)
  const localQuery = normalizeShortcutLocalSearchQuery(options.shortcutQuery)
  const matchesGlobalSearch = buildShortcutGlobalSearchMatcher(
    shortcutRows,
    options.settingsSearchQuery
  )
  const matchesSearch = (row: ShortcutRowsByGroup['rows'][number]): boolean =>
    localQuery !== null &&
    matchesGlobalSearch(row) &&
    matchesShortcutLocalSearch(row, localQuery, options.platform)
  const baseVisibleRows = shortcutRows.filter(matchesSearch)
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
        (row) => matchesSearch(row) && matchesShortcutFilter(row, options.shortcutFilter)
      )
    }))
    .filter((group) => group.rows.length > 0)

  return {
    filterCounts,
    shortcutRows,
    visibleShortcutCount: visibleShortcutGroups.reduce((sum, group) => sum + group.rows.length, 0),
    visibleShortcutGroups
  }
}
