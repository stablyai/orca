import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

for (const newCardStyle of [false, true]) {
  test(`reorders a collapsed parent with 53 children (${newCardStyle ? 'new' : 'legacy'} cards)`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const ids = await orcaPage.evaluate(async (newCardStyle) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing app store')
      }
      const state = store.getState()
      const repo = state.repos[0]!
      const template = state.worktreesByRepo[repo.id]![0]!
      const makeRow = (name: string, rank: number) => ({
        ...template,
        id: `${repo.id}::${name}`,
        instanceId: name,
        displayName: name,
        branch: `refs/heads/${name}`,
        isMainWorktree: false,
        isPinned: false,
        isArchived: false,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        manualOrder: rank,
        sortOrder: rank
      })
      const first = makeRow('First workspace', 100_000)
      const parent = makeRow('Parent with 53 children', 90_000)
      const last = makeRow('Last workspace', 10_000)
      const children = Array.from({ length: 53 }, (_, index) => {
        const child = makeRow(`Child ${index}`, 80_000 - index * 100)
        const lineage = {
          worktreeId: child.id,
          worktreeInstanceId: child.instanceId,
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: parent.instanceId,
          origin: 'manual' as const,
          capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
          createdAt: Date.now()
        }
        return { ...child, parentWorktreeId: parent.id, lineage }
      })
      const collapsedGroups = [
        `lineage:${parent.hostId ? `${parent.hostId}|${parent.id}` : parent.id}`
      ]
      await window.api.ui.set({ groupBy: 'none', collapsedGroups })
      store.setState({
        groupBy: 'none',
        sortBy: 'manual',
        sidebarOpen: true,
        settings: { ...state.settings, experimentalNewWorktreeCardStyle: newCardStyle },
        showActiveOnly: false,
        showSleepingWorkspaces: true,
        hideDefaultBranchWorkspace: false,
        filterRepoIds: [],
        collapsedGroups: new Set(collapsedGroups),
        worktreesByRepo: { [repo.id]: [first, parent, ...children, last] },
        worktreeLineageById: Object.fromEntries(children.map((child) => [child.id, child.lineage])),
        // Synthetic rows exercise the real drag path without persisting nonexistent checkouts.
        updateWorktreesMeta: async (updates) => {
          const byId = new Map(updates.map((update) => [update.worktreeId, update.updates]))
          store.setState((current) => ({
            sortEpoch: current.sortEpoch + 1,
            worktreesByRepo: Object.fromEntries(
              Object.entries(current.worktreesByRepo).map(([repoId, rows]) => [
                repoId,
                rows.map((row) => ({ ...row, ...byId.get(row.id) }))
              ])
            )
          }))
        }
      })
      return { first: first.id, parent: parent.id, last: last.id }
    }, newCardStyle)
    const sidebar = orcaPage.locator('[data-worktree-sidebar]')
    const parent = sidebar.locator(`[data-worktree-id=${JSON.stringify(ids.parent)}]`)
    const last = sidebar.locator(`[data-worktree-id=${JSON.stringify(ids.last)}]`)
    await expect(parent.getByRole('button', { name: 'Show 53 child workspaces' })).toBeVisible()
    await sidebar.screenshot({ path: testInfo.outputPath('before.png') })
    const source = await parent.boundingBox()
    const target = await last.boundingBox()
    if (!source || !target) {
      throw new Error('Missing card bounds')
    }
    await orcaPage.mouse.move(source.x + source.width / 2, source.y + 12)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(target.x + 2, target.y + target.height - 1, { steps: 12 })
    await expect(orcaPage.locator('[data-worktree-sidebar-drag-preview]')).toHaveCount(1)
    await orcaPage.mouse.up()
    try {
      await expect
        .poll(async () => {
          const [parentBox, lastBox] = await Promise.all([parent.boundingBox(), last.boundingBox()])
          return Boolean(parentBox && lastBox && parentBox.y > lastBox.y)
        })
        .toBe(true)
    } finally {
      await sidebar.screenshot({ path: testInfo.outputPath('after.png') })
    }
    const first = sidebar.locator(`[data-worktree-id=${JSON.stringify(ids.first)}]`)
    const movedSource = await parent.boundingBox()
    const upwardTarget = await first.boundingBox()
    if (!movedSource || !upwardTarget) {
      throw new Error('Missing reordered card bounds')
    }
    await orcaPage.mouse.move(movedSource.x + movedSource.width / 2, movedSource.y + 12)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(upwardTarget.x + 2, upwardTarget.y + 1, { steps: 12 })
    await orcaPage.mouse.up()
    await expect
      .poll(async () => {
        const [parentBox, firstBox] = await Promise.all([parent.boundingBox(), first.boundingBox()])
        return Boolean(parentBox && firstBox && parentBox.y < firstBox.y)
      })
      .toBe(true)
    // Wait for the drag's click suppression before exercising the children toggle.
    await orcaPage.waitForTimeout(550)
    await parent.getByRole('button', { name: 'Show 53 child workspaces' }).click()
    await expect(parent.getByRole('button', { name: 'Hide 53 child workspaces' })).toBeVisible()
    await expect(parent.locator('[role="option"]')).toHaveCount(53)
    await expect(parent.locator('[role="option"]').first()).toContainText('Child 0')
  })
}
