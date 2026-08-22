import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'

export async function expectFolderWorkspaceSidebarGrouping(
  page: Page,
  testInfo: TestInfo,
  args: {
    folderPath: string
    hostId: `runtime:${string}`
    localFolderPath: string
    screenshotPrefix: string
  }
): Promise<void> {
  const targets = await page.evaluate(({ folderPath, hostId, localFolderPath }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    const runtimeWorkspace = store
      .getState()
      .folderWorkspaces.find(
        (candidate) => candidate.folderPath === folderPath && candidate.executionHostId === hostId
      )
    const localWorkspace = store
      .getState()
      .folderWorkspaces.find(
        (candidate) =>
          candidate.folderPath === localFolderPath && candidate.executionHostId === 'local'
      )
    const runtimeGroup = runtimeWorkspace
      ? store
          .getState()
          .projectGroups.find(
            (group) =>
              group.id === runtimeWorkspace.projectGroupId && group.executionHostId === hostId
          )
      : null
    const localGroup = localWorkspace
      ? store
          .getState()
          .projectGroups.find(
            (group) =>
              group.id === localWorkspace.projectGroupId && group.executionHostId === 'local'
          )
      : null
    if (!runtimeWorkspace || !localWorkspace || !runtimeGroup || !localGroup) {
      throw new Error('Runtime folder unavailable for sidebar grouping')
    }
    store.getState().setVisibleWorkspaceHostIds(['local', hostId])
    return { runtimeWorkspace, localWorkspace, runtimeGroup, localGroup }
  }, args)
  expect(targets.runtimeWorkspace.executionHostId).toBe(args.hostId)
  expect(targets.localWorkspace.executionHostId).toBe('local')

  const cases = [
    { id: 'repo', label: 'Project' },
    { id: 'workspace-status', label: 'Status' },
    { id: 'pr-status', label: 'PR' },
    { id: 'none', label: 'None' }
  ] as const
  const runtimeIdentity = `${args.hostId}|folder:${targets.runtimeWorkspace.id}`
  const localIdentity = `local|folder:${targets.localWorkspace.id}`
  const placements: { groupBy: string; runtimeHostId: string; localHostId: string }[] = []

  for (const groupBy of cases) {
    await page.evaluate((groupById) => window.__store?.getState().setGroupBy(groupById), groupBy.id)
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().groupBy ?? null))
      .toBe(groupBy.id)
    await expect
      .poll(() =>
        page.evaluate(
          ({ folderPath, hostId }) =>
            window.__store
              ?.getState()
              .folderWorkspaces.some(
                (workspace) =>
                  workspace.folderPath === folderPath && workspace.executionHostId === hostId
              ) ?? false,
          args
        )
      )
      .toBe(true)
    await page.evaluate(
      ({ folderWorkspaceId, hostId }) => {
        window.__store?.getState().revealWorktreeInSidebar(`folder:${folderWorkspaceId}`, {
          behavior: 'auto',
          executionHostId: hostId
        })
      },
      { folderWorkspaceId: targets.runtimeWorkspace.id, hostId: args.hostId }
    )

    const runtimeRow = page.locator(`[data-worktree-host-identity="${runtimeIdentity}"]`)
    const localRow = page.locator(`[data-worktree-host-identity="${localIdentity}"]`)
    await expect(runtimeRow).toHaveCount(1)
    await expect(runtimeRow).toContainText(targets.runtimeWorkspace.name)
    await expect(localRow).toHaveCount(1)
    await expect(localRow).toContainText(targets.localWorkspace.name)
    await localRow.locator('[data-worktree-card-surface]').click()
    await expect
      .poll(() =>
        page.evaluate(() => ({
          worktreeId: window.__store?.getState().activeWorktreeId ?? null,
          hostId: window.__store?.getState().activeWorkspaceExecutionHostId ?? null
        }))
      )
      .toEqual({ worktreeId: `folder:${targets.localWorkspace.id}`, hostId: 'local' })
    await runtimeRow.locator('[data-worktree-card-surface]').click()
    await expect
      .poll(() =>
        page.evaluate(() => ({
          worktreeId: window.__store?.getState().activeWorktreeId ?? null,
          hostId: window.__store?.getState().activeWorkspaceExecutionHostId ?? null
        }))
      )
      .toEqual({ worktreeId: `folder:${targets.runtimeWorkspace.id}`, hostId: args.hostId })
    const placement = await page.evaluate(
      (targetIdentities) => {
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[data-worktree-sidebar] [data-index]')
        ].sort(
          (left, right) =>
            Number(left.dataset.index ?? Number.MAX_SAFE_INTEGER) -
            Number(right.dataset.index ?? Number.MAX_SAFE_INTEGER)
        )
        let hostId: string | null = null
        let projectGroupText: string | null = null
        const result: Record<string, { hostId: string | null; projectGroupText: string | null }> =
          {}
        for (const row of rows) {
          const hostHeader = row.querySelector<HTMLElement>('[data-host-header-drag-id]')
          if (hostHeader) {
            hostId = hostHeader.dataset.hostHeaderDragId ?? null
            projectGroupText = null
          }
          const projectGroupHeader = row.querySelector<HTMLElement>(
            '[data-project-group-header-id]'
          )
          if (projectGroupHeader) {
            projectGroupText = projectGroupHeader.textContent
          }
          const identity = row.dataset.worktreeHostIdentity
          if (identity && targetIdentities.includes(identity)) {
            result[identity] = { hostId, projectGroupText }
          }
        }
        return result
      },
      [runtimeIdentity, localIdentity]
    )
    expect(placement[runtimeIdentity]?.hostId).toBe(args.hostId)
    expect(placement[localIdentity]?.hostId).toBe('local')
    if (groupBy.id === 'repo') {
      expect(placement[runtimeIdentity]?.projectGroupText).toContain(targets.runtimeGroup.name)
      expect(placement[localIdentity]?.projectGroupText).toContain(targets.localGroup.name)
    }
    placements.push({
      groupBy: groupBy.id,
      runtimeHostId: placement[runtimeIdentity]!.hostId!,
      localHostId: placement[localIdentity]!.hostId!
    })
    await page.screenshot({
      path: testInfo.outputPath(`sta-4964-${args.screenshotPrefix}-${groupBy.id}.png`),
      fullPage: true
    })
  }

  console.info(`[sta-4964-sidebar] ${JSON.stringify(placements)}`)
}
