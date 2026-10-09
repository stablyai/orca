// One layout tab from today's two records per terminal tab (the row and the tab-bar entry).

import type { Tab } from '../tab-types'
import type { TerminalTab } from '../terminal-tab-types'
import type {
  LayoutContentTab,
  LayoutTerminalCreation,
  LayoutTerminalTab
} from './workspace-layout-model'
import { pickStoredFields } from './stored-record-fields'

const TERMINAL_CREATION_FIELDS = [
  'defaultTitle',
  'shellOverride',
  'forceHostRuntime',
  'startupCwd',
  'launchAgent',
  'agentLaunchPane'
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
