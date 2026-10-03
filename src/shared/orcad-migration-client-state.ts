import type { PersistedAutomationHostFilter } from './automation-host-filter'
import type { PersistedMobileClientTabSelections } from './persisted-state-types'
import type {
  ManualRepoOrderEntry,
  VisibleWorkspaceHostIds,
  WorkspaceHostOrder,
  WorkspaceHostScope
} from './ui-chrome-types'
import type { SavedPortForward } from './ssh-types'
import {
  parseClientHostedBrowserCloseIntents,
  parseMobileSelections,
  parseSavedPortForwards,
  parseUiRouting
} from './orcad-migration-client-state-parsing'
import { isWorkspaceHostId, isRecord } from './orcad-migration-client-state-value-validation'
import type { ClientHostedBrowserCloseIntent } from './client-hosted-browser-close-intent'

export {
  MAX_ORCAD_MIGRATION_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  MAX_ORCAD_MIGRATION_CLIENT_ROUTING_ENTRIES,
  MAX_ORCAD_MIGRATION_CLIENT_SELECTIONS,
  MAX_ORCAD_MIGRATION_SAVED_PORT_FORWARDS,
  parseClientHostedBrowserCloseIntents,
  parseMobileSelections,
  parseSavedPortForwards,
  parseUiRouting
} from './orcad-migration-client-state-parsing'

export type OrcadMigrationUiRoutingState = {
  lastActiveRepoId?: string | null
  lastActiveWorktreeId?: string | null
  filterRepoIds?: string[]
  showDotfilesByWorktree?: Record<string, boolean>
  setupScriptPromptDismissedRepoIds?: string[]
  manualRepoOrder?: ManualRepoOrderEntry[]
  workspaceHostScope?: WorkspaceHostScope
  visibleWorkspaceHostIds?: VisibleWorkspaceHostIds
  workspaceHostOrder?: WorkspaceHostOrder
  automationHostFilter?: PersistedAutomationHostFilter
  acknowledgedAgentsByPaneKey?: Record<string, number>
}

export type OrcadMigrationClientHostedBrowserCloseIntent = ClientHostedBrowserCloseIntent & {
  sourceEnvironmentId: string
}

export type OrcadMigrationClientStatePayload = {
  mobileClientTabSelectionsByDeviceId?: PersistedMobileClientTabSelections
  uiRouting?: OrcadMigrationUiRoutingState
  savedPortForwards?: SavedPortForward[]
  clientHostedBrowserCloseIntents?: OrcadMigrationClientHostedBrowserCloseIntent[]
}

export function parseOrcadMigrationClientState(value: unknown): OrcadMigrationClientStatePayload {
  if (!isRecord(value)) {
    throw new Error('orcad_migration_dormant_client_state_invalid')
  }
  const mobile =
    value.mobileClientTabSelectionsByDeviceId === undefined
      ? undefined
      : parseMobileSelections(value.mobileClientTabSelectionsByDeviceId)
  const uiRouting = value.uiRouting === undefined ? undefined : parseUiRouting(value.uiRouting)
  const savedPortForwards =
    value.savedPortForwards === undefined
      ? undefined
      : parseSavedPortForwards(value.savedPortForwards)
  const closeIntents =
    value.clientHostedBrowserCloseIntents === undefined
      ? undefined
      : parseClientHostedBrowserCloseIntents(value.clientHostedBrowserCloseIntents)
  return {
    ...(mobile && Object.keys(mobile).length > 0
      ? { mobileClientTabSelectionsByDeviceId: mobile }
      : {}),
    ...(uiRouting && Object.keys(uiRouting).length > 0 ? { uiRouting } : {}),
    ...(savedPortForwards && savedPortForwards.length > 0 ? { savedPortForwards } : {}),
    ...(closeIntents && closeIntents.length > 0
      ? { clientHostedBrowserCloseIntents: closeIntents }
      : {})
  }
}

export function parseOrcadMigrationUiRoutingState(value: unknown): OrcadMigrationUiRoutingState {
  return parseUiRouting(value)
}

export function parseOrcadMigrationSavedPortForwards(value: unknown): SavedPortForward[] {
  return parseSavedPortForwards(value)
}

export function parseOrcadMigrationClientHostedBrowserCloseIntents(
  value: unknown
): OrcadMigrationClientHostedBrowserCloseIntent[] {
  return parseClientHostedBrowserCloseIntents(value)
}

export function assertOrcadMigrationClientStateReferences(args: {
  clientState: OrcadMigrationClientStatePayload | undefined
  repositoryIds: ReadonlySet<string>
  owns: (ownerKey: string) => boolean
}): void {
  const clientState = args.clientState
  if (!clientState) {
    return
  }
  for (const selections of Object.values(clientState.mobileClientTabSelectionsByDeviceId ?? {})) {
    for (const worktreeId of Object.keys(selections)) {
      if (!args.owns(worktreeId)) {
        throw new Error('orcad_migration_dormant_mobile_selection_scope_invalid')
      }
    }
  }
  for (const intent of clientState.clientHostedBrowserCloseIntents ?? []) {
    if (!intent.sourceEnvironmentId || !args.owns(intent.worktreeId)) {
      throw new Error('orcad_migration_dormant_client_close_intent_scope_invalid')
    }
  }
  const ui = clientState.uiRouting
  if (!ui) {
    return
  }
  if (ui.lastActiveRepoId && !args.repositoryIds.has(ui.lastActiveRepoId)) {
    throw new Error('orcad_migration_dormant_ui_routing_scope_invalid')
  }
  if (ui.lastActiveWorktreeId && !args.owns(ui.lastActiveWorktreeId)) {
    throw new Error('orcad_migration_dormant_ui_routing_scope_invalid')
  }
  for (const repoId of ui.filterRepoIds ?? []) {
    if (!args.repositoryIds.has(repoId)) {
      throw new Error('orcad_migration_dormant_ui_routing_scope_invalid')
    }
  }
  for (const ownerKey of Object.keys(ui.showDotfilesByWorktree ?? {})) {
    if (!args.owns(ownerKey)) {
      throw new Error('orcad_migration_dormant_ui_routing_scope_invalid')
    }
  }
  for (const repoId of ui.setupScriptPromptDismissedRepoIds ?? []) {
    if (!args.repositoryIds.has(repoId)) {
      throw new Error('orcad_migration_dormant_ui_routing_scope_invalid')
    }
  }
  for (const entry of ui.manualRepoOrder ?? []) {
    if (!args.repositoryIds.has(entry.repoId) || !isWorkspaceHostId(entry.hostId)) {
      throw new Error('orcad_migration_dormant_ui_routing_scope_invalid')
    }
  }
}
