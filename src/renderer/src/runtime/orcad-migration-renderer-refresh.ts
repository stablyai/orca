import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { mapSettledWithConcurrency } from '../../../shared/map-with-concurrency'
import { useAppStore } from '../store'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '../store/slices/runtime-status'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import {
  assertOrcadMigrationProvisionalTabs,
  inspectOrcadMigrationMirrorCohort,
  assertOrcadMigrationMirrorApplied
} from './orcad-migration-mirror-cohort'
import {
  assertOrcadMigrationSourceCatalogRetired,
  buildOrcadMigrationSourceRepoPatch,
  buildOrcadMigrationSourceListingPatch
} from './orcad-migration-source-catalog'

/** A completed host retirement is not yet a usable renderer handoff. */
export async function refreshOrcadMigrationRenderer(
  environment: PublicKnownRuntimeEnvironment,
  migrationId: string,
  connectDestination: (environment: PublicKnownRuntimeEnvironment) => Promise<boolean>
): Promise<boolean> {
  const selection = { selector: environment.id, migrationId }
  const plan = await window.api.runtimeEnvironments.getOrcadLiveMigrationRendererPlan(selection)
  if (
    plan.destinationEnvironmentId !== environment.id ||
    plan.destinationRuntimeId !== environment.runtimeId
  ) {
    throw new Error('orcad_migration_renderer_destination_changed')
  }
  if (!(await connectDestination(environment))) {
    return false
  }
  const revision = getRuntimeEnvironmentRevision(environment.id)
  const generation = getRuntimeEnvironmentConnectionGeneration(environment.id)
  const assertCurrent = () => {
    if (
      revision !== getRuntimeEnvironmentRevision(environment.id) ||
      generation !== getRuntimeEnvironmentConnectionGeneration(environment.id) ||
      useAppStore.getState().runtimeStatusByEnvironmentId.get(environment.id)?.status?.runtimeId !==
        plan.destinationRuntimeId
    ) {
      throw new Error('orcad_migration_renderer_destination_changed')
    }
  }
  assertCurrent()
  const localOwner = { runtimeEnvironmentId: null }
  await useAppStore.getState().fetchRepos(localOwner)
  await useAppStore.getState().fetchProjectGroups(localOwner)
  await useAppStore.getState().fetchFolderWorkspaces(localOwner)
  assertCurrent()
  for (const workspace of plan.workspaces) {
    assertOrcadMigrationProvisionalTabs(useAppStore.getState(), workspace)
  }
  const retirement =
    await window.api.runtimeEnvironments.getOrcadLiveMigrationRendererPlan(selection)
  assertCurrent()
  if (serializeOrcadMigrationValue(retirement) !== serializeOrcadMigrationValue(plan)) {
    throw new Error('orcad_migration_renderer_retirement_changed')
  }
  for (const workspace of plan.workspaces) {
    assertOrcadMigrationProvisionalTabs(useAppStore.getState(), workspace)
  }
  useAppStore.setState((state) => buildOrcadMigrationSourceRepoPatch(state, plan))
  assertOrcadMigrationSourceCatalogRetired(useAppStore.getState(), plan)
  useAppStore.setState((state) => buildOrcadMigrationSourceListingPatch(state, plan))
  const results = await mapSettledWithConcurrency(plan.workspaces, 4, async (workspace) => {
    assertCurrent()
    let handles: Map<string, string> | undefined
    await refreshWebRuntimeSessionTabsSnapshot(environment.id, workspace.workspaceId, {
      expectedEnvironmentPairingRevision: revision,
      afterCurrentInFlight: true,
      errorMode: 'throw',
      validateSnapshot: (snapshot) => {
        assertCurrent()
        assertOrcadMigrationProvisionalTabs(useAppStore.getState(), workspace)
        handles = inspectOrcadMigrationMirrorCohort(workspace, snapshot)
      }
    })
    assertCurrent()
    if (!handles) {
      throw new Error('orcad_migration_renderer_snapshot_unverified')
    }
    assertOrcadMigrationMirrorApplied(useAppStore.getState(), environment.id, workspace, handles)
    return { workspace, handles }
  })
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
  const confirmed =
    await window.api.runtimeEnvironments.getOrcadLiveMigrationRendererPlan(selection)
  assertCurrent()
  if (serializeOrcadMigrationValue(confirmed) !== serializeOrcadMigrationValue(plan)) {
    throw new Error('orcad_migration_renderer_retirement_changed')
  }
  assertOrcadMigrationSourceCatalogRetired(useAppStore.getState(), plan)
  for (const result of results) {
    if (result.status === 'fulfilled') {
      assertOrcadMigrationMirrorApplied(
        useAppStore.getState(),
        environment.id,
        result.value.workspace,
        result.value.handles
      )
    }
  }
  return true
}
