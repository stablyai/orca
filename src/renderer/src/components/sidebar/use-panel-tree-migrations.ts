import React from 'react'
import type { PanelTreeGroup, PinnedTerminalPanel, PinnedWebPanel } from '../../../../shared/types'
import { migrateLegacyPanelGroups } from '../../../../shared/panel-tree'
import { migrateCollapsedPanelGroupKeys } from '../../../../shared/panel-tree-collapse-keys'
import { PINNED_TERMINAL_PANELS_ROOT_FOLD } from '../../../../shared/pinned-terminal-panels'

type UpdateSettings = (updates: {
  panelTreeGroups?: PanelTreeGroup[]
  pinnedTerminalPanels?: PinnedTerminalPanel[]
  pinnedWebPanels?: PinnedWebPanel[]
  collapsedPinnedTerminalPanelGroups?: string[]
}) => void | Promise<void>

/**
 * One-shot panel-tree migrations (legacy group labels → groupId, collapse
 * title keys → id keys). Ref-guarded so settings churn cannot loop.
 */
export function usePanelTreeMigrations(args: {
  panelTreeGroups: PanelTreeGroup[] | undefined
  pinnedTerminalPanels: PinnedTerminalPanel[] | undefined
  pinnedWebPanels: PinnedWebPanel[] | undefined
  collapsedGroups: string[] | undefined
  updateSettings: UpdateSettings
}): void {
  const {
    panelTreeGroups,
    pinnedTerminalPanels,
    pinnedWebPanels,
    collapsedGroups,
    updateSettings
  } = args

  const legacyGroupMigrationAttempted = React.useRef(false)
  React.useEffect(() => {
    if (legacyGroupMigrationAttempted.current) {
      return
    }
    const terms = pinnedTerminalPanels ?? []
    const webs = pinnedWebPanels ?? []
    const groups = panelTreeGroups ?? []
    // Why: only panels still missing groupId need migration.
    const needs = terms.some((p) => Boolean(p.group) && !p.groupId)
    if (!needs) {
      return
    }
    legacyGroupMigrationAttempted.current = true
    const migrated = migrateLegacyPanelGroups({
      groups,
      terminalPanels: terms,
      webPanels: webs
    })
    void updateSettings({
      panelTreeGroups: migrated.groups,
      pinnedTerminalPanels: migrated.terminalPanels,
      pinnedWebPanels: migrated.webPanels
    })
  }, [panelTreeGroups, pinnedTerminalPanels, pinnedWebPanels, updateSettings])

  const collapseKeyMigrationAttempted = React.useRef(false)
  React.useEffect(() => {
    if (collapseKeyMigrationAttempted.current) {
      return
    }
    const next = migrateCollapsedPanelGroupKeys(
      panelTreeGroups ?? [],
      collapsedGroups ?? [],
      PINNED_TERMINAL_PANELS_ROOT_FOLD
    )
    if (!next) {
      return
    }
    collapseKeyMigrationAttempted.current = true
    void updateSettings({ collapsedPinnedTerminalPanelGroups: next })
  }, [panelTreeGroups, collapsedGroups, updateSettings])
}
