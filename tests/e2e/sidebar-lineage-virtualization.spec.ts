import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { seedWorkspaceAgentStatus } from './worktree-lineage-state'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

for (const newCardStyle of [false, true]) {
  test(`virtualizes 500 lineage children with ${newCardStyle ? 'new' : 'legacy'} card surfaces`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { parentId, targetId } = await orcaPage.evaluate((newCardStyle) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const worktrees = Object.values(state.worktreesByRepo).flat()
      const parent = worktrees[0]
      const template = worktrees[1]
      if (!parent?.instanceId || !template) {
        throw new Error('Lineage fixtures unavailable')
      }
      state.setActiveView('terminal')
      state.setSidebarOpen(true)
      state.setGroupBy('none')
      state.setSortBy('manual')
      state.setShowActiveOnly(false)
      state.setShowSleepingWorkspaces(true)
      state.setHideDefaultBranchWorkspace(false)
      state.setFilterRepoIds([])
      state.setWorktreeCardProperties(['status', 'branch', 'inline-agents'])
      const children = Array.from({ length: 500 }, (_, index) => {
        const id = `e2e-virtual-child-${index}`
        const instanceId = `e2e-virtual-instance-${index}`
        const nestedParent = index === 400 || index === 401 ? index - 1 : null
        const parentWorktreeId =
          nestedParent === null ? parent.id : `e2e-virtual-child-${nestedParent}`
        const parentInstanceId =
          nestedParent === null ? parent.instanceId : `e2e-virtual-instance-${nestedParent}`
        return {
          ...template,
          id,
          instanceId,
          repoId: parent.repoId,
          hostId: parent.hostId,
          displayName: `Virtual child ${index}`,
          isPinned: false,
          isMainWorktree: false,
          sortOrder: 500 - index,
          parentWorktreeId,
          childWorktreeIds: [],
          lineage: {
            worktreeId: id,
            worktreeInstanceId: instanceId,
            parentWorktreeId,
            parentWorktreeInstanceId: parentInstanceId,
            origin: 'manual' as const,
            capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
            createdAt: 1
          }
        }
      })
      store.setState((current) => ({
        settings: current.settings
          ? { ...current.settings, experimentalNewWorktreeCardStyle: newCardStyle }
          : current.settings,
        worktreesByRepo: {
          [parent.repoId]: [
            { ...parent, displayName: 'Virtual lineage parent', isPinned: false, sortOrder: 0 },
            ...children
          ]
        },
        worktreeLineageById: Object.fromEntries(children.map((child) => [child.id, child.lineage])),
        collapsedGroups: new Set(),
        agentActivityDisplayMode: 'full'
      }))
      store.getState().setActiveWorktree(parent.id)
      return { parentId: parent.id, targetId: children[400]!.id }
    }, newCardStyle)

    const childCards = orcaPage.locator('[data-lineage-virtual-item]')
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeVisible()
    await expect.poll(() => childCards.count()).toBeGreaterThan(1)
    const topMounted = await childCards.count()
    expect(topMounted).toBeLessThan(60)
    await orcaPage.screenshot({ path: testInfo.outputPath('lineage-top.png') })

    await orcaPage.evaluate(
      (targetId) =>
        window.__store
          ?.getState()
          .revealWorktreeInSidebar(targetId, { behavior: 'auto', highlight: false }),
      targetId
    )
    await expect(worktreeRow(orcaPage, targetId)).toBeInViewport()
    const targetTitle = worktreeRow(orcaPage, targetId).getByText('Virtual child 400', {
      exact: true
    })
    await expect(targetTitle).toBeInViewport()
    await expect
      .poll(() =>
        targetTitle.evaluate((element) => {
          const sidebar = element.closest('[data-worktree-sidebar]')!
          return element.getBoundingClientRect().top - sidebar.getBoundingClientRect().top
        })
      )
      .toBeGreaterThanOrEqual(30)
    await expect(
      worktreeRow(orcaPage, 'e2e-virtual-child-399').locator(`[data-worktree-id="${targetId}"]`)
    ).toBeVisible()
    await expect(
      worktreeRow(orcaPage, targetId).locator('[data-worktree-id="e2e-virtual-child-401"]')
    ).toBeVisible()
    const revealedMounted = await childCards.count()
    expect(revealedMounted).toBeLessThan(60)
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toHaveCount(0)
    await orcaPage.screenshot({ path: testInfo.outputPath('lineage-descendant-400.png') })
    const metricsPath = testInfo.outputPath('lineage-mounted-counts.json')
    await writeFile(
      metricsPath,
      JSON.stringify({ totalChildren: 500, topMounted, revealedMounted, newCardStyle }, null, 2)
    )
    await testInfo.attach('lineage-mounted-counts', {
      path: metricsPath,
      contentType: 'application/json'
    })

    const targetTop = (await worktreeRow(orcaPage, targetId).boundingBox())!.y
    const above = worktreeRow(orcaPage, 'e2e-virtual-child-390')
    const previousHeight = (await above.boundingBox())!.height
    // The existing sidebar policy suppresses corrections for 500 ms after scroll movement.
    await orcaPage.waitForTimeout(650)
    await seedWorkspaceAgentStatus(orcaPage, 'e2e-virtual-child-390', 'HEIGHT')
    await expect
      .poll(async () => (await above.boundingBox())?.height ?? 0)
      .toBeGreaterThan(previousHeight + 10)
    await expect
      .poll(async () =>
        Math.abs(((await worktreeRow(orcaPage, targetId).boundingBox())?.y ?? 0) - targetTop)
      )
      .toBeLessThan(2)

    await orcaPage.evaluate(
      (parentId) =>
        window.__store
          ?.getState()
          .revealWorktreeInSidebar(parentId, { behavior: 'auto', highlight: false }),
      parentId
    )
    const parentRow = worktreeRow(orcaPage, parentId)
    const toggle = parentRow.getByRole('button', { name: /Hide 498 child workspaces/i })
    await expect(toggle).toBeInViewport()
    await toggle.click()
    await expect(childCards).toHaveCount(0)
    await parentRow.getByRole('button', { name: /Show 498 child workspaces/i }).click()
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
    expect(await childCards.count()).toBeLessThan(60)
  })
}
