// One layout tab from today's two records per terminal tab (the row and the tab-bar entry).

import type { Tab } from '../tab-types'
import type { TerminalTab } from '../terminal-tab-types'
import type {
  LayoutContentTab,
  LayoutTerminalCreation,
  LayoutTerminalTab
} from './workspace-layout-model'
import { pickStoredFields } from './stored-record-fields'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'

const TERMINAL_CREATION_FIELDS = [
  'defaultTitle',
  'shellOverride',
  'forceHostRuntime',
  'startupCwd',
  'launchAgent'
] as const satisfies readonly (keyof LayoutTerminalCreation)[]

function contentFields(entry: Tab) {
  return {
    id: entry.id,
    entityId: entry.entityId,
    createdAt: entry.createdAt,
    customTitle: entry.customLabel,
    color: entry.color,
    ...pickStoredFields(entry, [
      'aiVaultTitle',
      'quickCommandLabel',
      'isPinned',
      'viewMode',
      'isPreview',
      'agentSessionAgent'
    ]),
    ...(entry.generatedLabel !== undefined ? { generatedTitle: entry.generatedLabel } : {})
  }
}

export function loadContentTab(
  entry: Tab & { contentType: LayoutContentTab['kind'] }
): LayoutContentTab {
  return { ...contentFields(entry), kind: entry.contentType }
}

/** Where both records name a field, the row wins: every runtime writer updates the row. */
export function loadTerminalTab(
  row: TerminalTab,
  entry: Tab | undefined
): Omit<LayoutTerminalTab, 'panes'> {
  const base = entry
    ? contentFields(entry)
    : { id: row.id, entityId: row.id, customTitle: null, color: null }
  return {
    ...base,
    ...pickStoredFields(row, [
      'aiVaultTitle',
      'quickCommandLabel',
      'isPinned',
      'viewMode',
      'generatedTitle'
    ]),
    createdAt: row.createdAt,
    customTitle: row.customTitle,
    color: row.color,
    kind: 'terminal',
    terminal: pickStoredFields(row, TERMINAL_CREATION_FIELDS)
  }
}

/**
 * A saved session's later editor tabs for a file one group already shows, by tab id → the tab
 * kept: the window's restore folds them the same way (dedupeEditorTabsWithinGroups), keeping the
 * one its strip shows first. Older builds could save them; layout-owner builds only.
 */
export function duplicateEditorTabAliases(entries: readonly Tab[]): Map<string, string> {
  const aliases = new Map<string, string>()
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return aliases
  }
  const kept = new Map<string, string>()
  const editors = entries
    .filter((entry) => entry.contentType === 'editor')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  for (const entry of editors) {
    const key = `${entry.groupId}\0${entry.entityId}`
    const first = kept.get(key)
    if (first === undefined) {
      kept.set(key, entry.id)
    } else if (first !== entry.id) {
      aliases.set(entry.id, first)
    }
  }
  return aliases
}
