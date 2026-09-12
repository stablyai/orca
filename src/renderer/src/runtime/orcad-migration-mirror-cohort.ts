import type { OrcadLiveMigrationRendererPlan } from '../../../shared/orcad-live-migration-renderer-plan'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { AppState } from '../store/types'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'

type Workspace = OrcadLiveMigrationRendererPlan['workspaces'][number]
type CohortState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'pendingStartupByTabId'
>

/** A matching tab id alone must not replace a newer source process. */
export function assertOrcadMigrationProvisionalTabs(
  state: CohortState,
  workspace: Workspace
): void {
  const byTab = new Map<string, Set<string>>()
  for (const terminal of workspace.terminals) {
    const ptys = byTab.get(terminal.tabId) ?? new Set<string>()
    ptys.add(terminal.sourcePtyId)
    byTab.set(terminal.tabId, ptys)
  }
  for (const [tabId, ptys] of byTab) {
    const tab = state.tabsByWorktree[workspace.workspaceId]?.find((entry) => entry.id === tabId)
    if (!tab) {
      continue
    }
    const bindings = [
      tab.ptyId,
      ...(state.ptyIdsByTabId[tabId] ?? []),
      ...Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})
    ]
    if (state.pendingStartupByTabId[tabId] || bindings.some((id) => id && !ptys.has(id))) {
      throw new Error('orcad_migration_renderer_source_identity_changed')
    }
  }
}

export function inspectOrcadMigrationMirrorCohort(
  workspace: Workspace,
  snapshot: RuntimeMobileSessionTabsResult
): Map<string, string> {
  if (snapshot.worktree !== workspace.workspaceId) {
    throw new Error('orcad_migration_renderer_workspace_changed')
  }
  const handles = new Map<string, string>()
  const surfaces = new Map<string, RuntimeMobileSessionTabsResult['tabs'][number] | null>()
  for (const tab of snapshot.tabs) {
    if (tab.type === 'terminal') {
      const key = `${tab.parentTabId}:${tab.leafId}`
      surfaces.set(key, surfaces.has(key) ? null : tab)
    }
  }
  for (const terminal of workspace.terminals) {
    const tab = surfaces.get(`${terminal.tabId}:${terminal.leafId}`)
    if (!tab || tab.type !== 'terminal') {
      throw new Error(
        'orcad_migration_renderer_destination_cohort_unverified:surface_missing_or_duplicate'
      )
    }
    if (tab.status !== 'ready') {
      throw new Error('orcad_migration_renderer_destination_cohort_unverified:not_ready')
    }
    if (tab.incarnationId !== terminal.incarnationId) {
      throw new Error(
        `orcad_migration_renderer_destination_cohort_unverified:${tab.incarnationId ? 'incarnation_changed' : 'incarnation_missing'}`
      )
    }
    if (!tab.terminal) {
      throw new Error('orcad_migration_renderer_destination_cohort_unverified:handle_missing')
    }
    handles.set(`${terminal.tabId}:${terminal.leafId}`, tab.terminal)
  }
  return handles
}

export function assertOrcadMigrationMirrorApplied(
  state: CohortState,
  environmentId: string,
  workspace: Workspace,
  handles: ReadonlyMap<string, string>
): void {
  const tabIds = new Set((state.tabsByWorktree[workspace.workspaceId] ?? []).map((tab) => tab.id))
  for (const terminal of workspace.terminals) {
    const tabId = toWebTerminalSurfaceTabId(terminal.tabId)
    const handle = handles.get(`${terminal.tabId}:${terminal.leafId}`)
    if (
      !handle ||
      tabIds.has(terminal.tabId) ||
      !tabIds.has(tabId) ||
      state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[terminal.leafId] !==
        toRemoteRuntimePtyId(handle, environmentId)
    ) {
      throw new Error('orcad_migration_renderer_destination_not_applied')
    }
  }
}
