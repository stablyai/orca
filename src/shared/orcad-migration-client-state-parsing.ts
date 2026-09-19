import { parseHostStableKey } from './automation-owner-key'
import {
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  type ClientHostedBrowserCloseIntent
} from './client-hosted-browser-close-intent'
import type {
  OrcadMigrationClientHostedBrowserCloseIntent,
  OrcadMigrationUiRoutingState
} from './orcad-migration-client-state'
import type { PersistedMobileClientTabSelections } from './persisted-state-types'
import type {
  ManualRepoOrderEntry,
  VisibleWorkspaceHostIds,
  WorkspaceHostOrder
} from './ui-chrome-types'
import type { SavedPortForward } from './ssh-types'
import {
  isRecord,
  isWorkspaceHostId,
  isWorkspaceHostScope,
  nullableString,
  parseSavedPortForwards as parseSavedPortForwardsValue,
  parseStringArray,
  requiredRecord
} from './orcad-migration-client-state-value-validation'

export const MAX_ORCAD_MIGRATION_CLIENT_SELECTIONS = 4_096
export const MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES = 16_384
export const MAX_ORCAD_MIGRATION_SAVED_PORT_FORWARDS = 256
export const MAX_ORCAD_MIGRATION_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS =
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS

export function parseClientHostedBrowserCloseIntents(
  value: unknown
): OrcadMigrationClientHostedBrowserCloseIntent[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ORCAD_MIGRATION_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS
  ) {
    throw new Error('orcad_migration_dormant_client_close_intents_invalid')
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    const record = requiredRecord(entry, 'orcad_migration_dormant_client_close_intent_invalid')
    if (
      typeof record.sourceEnvironmentId !== 'string' ||
      !record.sourceEnvironmentId ||
      record.sourceEnvironmentId.length > 256
    ) {
      throw new Error('orcad_migration_dormant_client_close_intent_environment_invalid')
    }
    if (typeof record.browserPageId !== 'string' || !record.browserPageId) {
      throw new Error('orcad_migration_dormant_client_close_intent_page_invalid')
    }
    if (typeof record.worktreeId !== 'string' || !record.worktreeId) {
      throw new Error('orcad_migration_dormant_client_close_intent_worktree_invalid')
    }
    if (!Number.isSafeInteger(record.closedAt) || Number(record.closedAt) < 0) {
      throw new Error('orcad_migration_dormant_client_close_intent_timestamp_invalid')
    }
    const parsed = {
      sourceEnvironmentId: record.sourceEnvironmentId,
      browserPageId: record.browserPageId,
      worktreeId: record.worktreeId,
      closedAt: Number(record.closedAt)
    } satisfies OrcadMigrationClientHostedBrowserCloseIntent
    const key = `${parsed.sourceEnvironmentId}\0${parsed.browserPageId}\0${parsed.worktreeId}`
    if (seen.has(key)) {
      throw new Error('orcad_migration_dormant_client_close_intent_duplicate')
    }
    seen.add(key)
    return parsed
  })
}

export function parseMobileSelections(value: unknown): PersistedMobileClientTabSelections {
  const record = requiredRecord(value, 'orcad_migration_dormant_mobile_selections_invalid')
  const result: PersistedMobileClientTabSelections = {}
  let count = 0
  for (const [deviceId, byWorktree] of Object.entries(record)) {
    if (!deviceId || !isRecord(byWorktree)) {
      throw new Error('orcad_migration_dormant_mobile_selections_invalid')
    }
    const entries: PersistedMobileClientTabSelections[string] = {}
    for (const [worktreeId, rawSelection] of Object.entries(byWorktree)) {
      if (!worktreeId || !isRecord(rawSelection)) {
        throw new Error('orcad_migration_dormant_mobile_selection_invalid')
      }
      const activeTabId = nullableString(rawSelection.activeTabId)
      const activeGroupId = nullableString(rawSelection.activeGroupId)
      const activeTabIdByGroupId = requiredRecord(
        rawSelection.activeTabIdByGroupId,
        'orcad_migration_dormant_mobile_selection_tabs_invalid'
      )
      const tabs: Record<string, string> = {}
      for (const [groupId, tabId] of Object.entries(activeTabIdByGroupId)) {
        if (!groupId || typeof tabId !== 'string' || !tabId) {
          throw new Error('orcad_migration_dormant_mobile_selection_tabs_invalid')
        }
        tabs[groupId] = tabId
      }
      if (!activeTabId && !activeGroupId && Object.keys(tabs).length === 0) {
        continue
      }
      entries[worktreeId] = { activeTabId, activeGroupId, activeTabIdByGroupId: tabs }
      count += 1
      if (count > MAX_ORCAD_MIGRATION_CLIENT_SELECTIONS) {
        throw new Error('orcad_migration_dormant_mobile_selections_too_many')
      }
    }
    if (Object.keys(entries).length > 0) {
      result[deviceId] = entries
    }
  }
  return result
}

export function parseUiRouting(value: unknown): OrcadMigrationUiRoutingState {
  const record = requiredRecord(value, 'orcad_migration_dormant_ui_routing_invalid')
  const result: OrcadMigrationUiRoutingState = {}
  if ('lastActiveRepoId' in record) {
    result.lastActiveRepoId = nullableString(record.lastActiveRepoId)
  }
  if ('lastActiveWorktreeId' in record) {
    result.lastActiveWorktreeId = nullableString(record.lastActiveWorktreeId)
  }
  if ('filterRepoIds' in record) {
    result.filterRepoIds = parseStringArray(
      record.filterRepoIds,
      MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES
    )
  }
  if ('showDotfilesByWorktree' in record) {
    const entries = requiredRecord(
      record.showDotfilesByWorktree,
      'orcad_migration_dormant_ui_dotfiles_invalid'
    )
    if (Object.keys(entries).length > MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES) {
      throw new Error('orcad_migration_dormant_ui_routing_too_many')
    }
    result.showDotfilesByWorktree = {}
    for (const [key, enabled] of Object.entries(entries)) {
      if (!key || typeof enabled !== 'boolean') {
        throw new Error('orcad_migration_dormant_ui_dotfiles_invalid')
      }
      result.showDotfilesByWorktree[key] = enabled
    }
  }
  if ('setupScriptPromptDismissedRepoIds' in record) {
    result.setupScriptPromptDismissedRepoIds = parseStringArray(
      record.setupScriptPromptDismissedRepoIds,
      MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES
    )
  }
  if ('manualRepoOrder' in record) {
    const entries = record.manualRepoOrder
    if (!Array.isArray(entries) || entries.length > MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES) {
      throw new Error('orcad_migration_dormant_ui_routing_invalid')
    }
    result.manualRepoOrder = entries.map((entry) => {
      const parsed = requiredRecord(entry, 'orcad_migration_dormant_ui_manual_order_invalid')
      if (
        typeof parsed.hostId !== 'string' ||
        !parsed.hostId ||
        typeof parsed.repoId !== 'string' ||
        !parsed.repoId
      ) {
        throw new Error('orcad_migration_dormant_ui_manual_order_invalid')
      }
      return { hostId: parsed.hostId as ManualRepoOrderEntry['hostId'], repoId: parsed.repoId }
    })
  }
  if ('workspaceHostScope' in record) {
    if (!isWorkspaceHostScope(record.workspaceHostScope)) {
      throw new Error('orcad_migration_dormant_ui_host_scope_invalid')
    }
    result.workspaceHostScope = record.workspaceHostScope
  }
  if ('visibleWorkspaceHostIds' in record) {
    if (record.visibleWorkspaceHostIds !== null) {
      const ids = parseStringArray(
        record.visibleWorkspaceHostIds,
        MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES
      )
      if (!ids.every(isWorkspaceHostId)) {
        throw new Error('orcad_migration_dormant_ui_visible_hosts_invalid')
      }
      result.visibleWorkspaceHostIds = ids as VisibleWorkspaceHostIds
    } else {
      result.visibleWorkspaceHostIds = null
    }
  }
  if ('workspaceHostOrder' in record) {
    const ids = parseStringArray(
      record.workspaceHostOrder,
      MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES
    )
    if (!ids.every(isWorkspaceHostId)) {
      throw new Error('orcad_migration_dormant_ui_host_order_invalid')
    }
    result.workspaceHostOrder = ids as WorkspaceHostOrder
  }
  if ('automationHostFilter' in record) {
    const filter = requiredRecord(
      record.automationHostFilter,
      'orcad_migration_dormant_ui_automation_filter_invalid'
    )
    if (filter.kind === 'all') {
      result.automationHostFilter = { kind: 'all' }
    } else if (
      filter.kind === 'host' &&
      typeof filter.hostKey === 'string' &&
      filter.hostKey &&
      parseHostStableKey(filter.hostKey)
    ) {
      result.automationHostFilter = { kind: 'host', hostKey: filter.hostKey }
    } else {
      throw new Error('orcad_migration_dormant_ui_automation_filter_invalid')
    }
  }
  if ('acknowledgedAgentsByPaneKey' in record) {
    const entries = requiredRecord(
      record.acknowledgedAgentsByPaneKey,
      'orcad_migration_dormant_ui_acknowledgements_invalid'
    )
    if (Object.keys(entries).length > MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES) {
      throw new Error('orcad_migration_dormant_ui_routing_too_many')
    }
    result.acknowledgedAgentsByPaneKey = {}
    for (const [key, timestamp] of Object.entries(entries)) {
      if (!key || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('orcad_migration_dormant_ui_acknowledgements_invalid')
      }
      result.acknowledgedAgentsByPaneKey[key] = timestamp
    }
  }
  return result
}

export function parseSavedPortForwards(value: unknown): SavedPortForward[] {
  return parseSavedPortForwardsValue(value, MAX_ORCAD_MIGRATION_SAVED_PORT_FORWARDS)
}

export type { ClientHostedBrowserCloseIntent }
