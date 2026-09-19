import { expect, type Page } from '@stablyai/playwright-test'
import type { OrcadLiveMigrationRendererPlan } from '../../../src/shared/orcad-live-migration-renderer-plan'

export async function assertRestartedOrcadMigration(
  page: Page,
  plan: OrcadLiveMigrationRendererPlan,
  activeRuntimeEnvironmentId: string | null | undefined
): Promise<void> {
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    {
      timeout: 60_000
    }
  )
  const retained = await page.evaluate(async (plan) => {
    const environments = await window.api.runtimeEnvironments.list()
    return {
      environment: environments.find(
        (environment) => environment.id === plan.destinationEnvironmentId
      ),
      migrations: await window.api.runtimeEnvironments.listOrcadLiveMigrations({
        selector: plan.destinationEnvironmentId
      }),
      plan: await window.api.runtimeEnvironments.getOrcadLiveMigrationRendererPlan({
        selector: plan.destinationEnvironmentId,
        migrationId: plan.migrationId
      })
    }
  }, plan)
  expect(retained.environment).toEqual(
    expect.objectContaining({
      id: plan.destinationEnvironmentId,
      runtimeId: plan.destinationRuntimeId
    })
  )
  expect(retained.migrations).toEqual([
    expect.objectContaining({
      migrationId: plan.migrationId,
      sourceSshTargetId: plan.sourceSshTargetId,
      sourceRetirement: 'complete',
      phaseEvidence: 'journal-retained',
      receipts: { recorded: 2, total: 2 }
    })
  ])
  expect(retained.plan).toEqual(plan)
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ plan, activeRuntimeEnvironmentId }) => {
            const state = window.__store!.getState()
            const sourceHost = `ssh:${encodeURIComponent(plan.sourceSshTargetId)}`
            const ownsSource = (row: {
              connectionId?: string | null
              executionHostId?: string | null
            }) =>
              row.executionHostId
                ? row.executionHostId === sourceHost
                : row.connectionId === plan.sourceSshTargetId
            const retiredRows = [
              ...state.repos.filter(
                (row) => plan.sourceCatalog.repoIds.includes(row.id) && ownsSource(row)
              ),
              ...state.projectGroups.filter(
                (row) => plan.sourceCatalog.projectGroupIds.includes(row.id) && ownsSource(row)
              ),
              ...state.folderWorkspaces.filter(
                (row) => plan.sourceCatalog.folderWorkspaceIds.includes(row.id) && ownsSource(row)
              )
            ]
            const workspaceIds = new Set(plan.workspaces.map((workspace) => workspace.workspaceId))
            const retiredListings = [
              ...Object.values(state.worktreesByRepo).flat(),
              ...Object.values(state.detectedWorktreesByRepo).flatMap(
                (listing) => listing.worktrees
              )
            ].filter(
              (row) =>
                workspaceIds.has(row.id) &&
                row.hostId === sourceHost &&
                !row.runtimeOwnerEnvironmentId
            )
            const destinationHost = `runtime:${plan.destinationEnvironmentId}` as const
            const destinationReady = plan.workspaces.every((workspace) => {
              if (workspace.workspaceId.startsWith('folder:')) {
                return state.folderWorkspaces.some(
                  (row) =>
                    row.id === workspace.workspaceId.slice('folder:'.length) &&
                    row.executionHostId === destinationHost
                )
              }
              return Boolean(state.getKnownWorktreeById(workspace.workspaceId, destinationHost))
            })
            return {
              retiredRows: retiredRows.length,
              retiredListings: retiredListings.length,
              destinationReady,
              preferencePreserved:
                state.settings?.activeRuntimeEnvironmentId === activeRuntimeEnvironmentId
            }
          },
          { plan, activeRuntimeEnvironmentId }
        ),
      { timeout: 60_000 }
    )
    .toEqual({
      retiredRows: 0,
      retiredListings: 0,
      destinationReady: true,
      preferencePreserved: true
    })
  const sourceSession = await page.evaluate(
    (targetId) => window.api.session.get(`ssh:${encodeURIComponent(targetId)}`),
    plan.sourceSshTargetId
  )
  for (const workspace of plan.workspaces) {
    expect(sourceSession.tabsByWorktree[workspace.workspaceId] ?? []).toEqual([])
    for (const terminal of workspace.terminals) {
      expect(sourceSession.terminalLayoutsByTabId[terminal.tabId]).toBeUndefined()
    }
  }
}
