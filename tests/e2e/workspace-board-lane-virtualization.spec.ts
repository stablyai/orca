import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const SEEDED_WORKSPACE_COUNT = 300
const MARQUEE_WORKSPACE_COUNT = 102

/**
 * Why: the board used to mount every workspace card in every lane in one
 * commit, which blocked the sheet open for seconds on a large workspace set.
 * These assert the lane renders a window instead, and that each rendered card
 * still carries its true lane index so drop targeting stays correct.
 */
test.describe('Workspace board lane virtualization', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('mounts a window of cards for a large lane and keeps lane indexes', async ({ orcaPage }) => {
    await orcaPage.evaluate((count) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const repo = state.repos[0]
      if (!repo) {
        throw new Error('Expected a seeded e2e repo')
      }

      const now = Date.now()
      const seeded = state.worktreesByRepo[repo.id] ?? []
      const synthetic = Array.from({ length: count }, (_, index) => {
        const suffix = String(index).padStart(3, '0')
        return {
          id: `${repo.id}::/virtual-board-${suffix}`,
          instanceId: `virtual-board-${suffix}`,
          repoId: repo.id,
          path: `${repo.path}/../virtual-board-${suffix}`,
          displayName: `Virtual board ${suffix}`,
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 10_000 - index,
          lastActivityAt: now - index - 100,
          head: '0000000000000000000000000000000000000000',
          branch: `virtual-board-${suffix}`,
          isBare: false,
          isMainWorktree: false,
          workspaceStatus: 'in-progress'
        }
      })

      state.setSidebarOpen(true)
      state.setShowSleepingWorkspaces(true)
      state.setHideDefaultBranchWorkspace(false)
      state.setFilterRepoIds([])
      store.setState({
        sortBy: 'manual',
        worktreesByRepo: { ...state.worktreesByRepo, [repo.id]: [...seeded, ...synthetic] }
      })
    }, SEEDED_WORKSPACE_COUNT)

    await orcaPage.getByRole('button', { name: 'Workspace board' }).click()

    const cards = orcaPage.locator('[data-workspace-board-card-id]')
    // Why: an empty window would also satisfy "fewer than seeded"; the point of
    // the change is a filled window, not a blank board.
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(3)
    expect(await cards.count()).toBeLessThan(SEEDED_WORKSPACE_COUNT / 2)

    const indexes = await cards.evaluateAll((elements) =>
      elements.map((element) =>
        Number((element as HTMLElement).dataset.workspaceBoardCardIndex ?? -1)
      )
    )
    expect(indexes.every((index) => Number.isInteger(index) && index >= 0)).toBe(true)
    expect(new Set(indexes).size).toBe(indexes.length)
  })

  test('renders later lane indexes after the lane scrolls', async ({ orcaPage }) => {
    await orcaPage.evaluate((count) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const repo = state.repos[0]
      if (!repo) {
        throw new Error('Expected a seeded e2e repo')
      }
      const now = Date.now()
      const seeded = state.worktreesByRepo[repo.id] ?? []
      const synthetic = Array.from({ length: count }, (_, index) => ({
        id: `${repo.id}::/virtual-scroll-${index}`,
        instanceId: `virtual-scroll-${index}`,
        repoId: repo.id,
        path: `${repo.path}/../virtual-scroll-${index}`,
        displayName: `Virtual scroll ${index}`,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 10_000 - index,
        lastActivityAt: now - index - 100,
        head: '0000000000000000000000000000000000000000',
        branch: `virtual-scroll-${index}`,
        isBare: false,
        isMainWorktree: false,
        workspaceStatus: 'in-progress'
      }))
      state.setSidebarOpen(true)
      state.setShowSleepingWorkspaces(true)
      state.setFilterRepoIds([])
      store.setState({
        sortBy: 'manual',
        worktreesByRepo: { ...state.worktreesByRepo, [repo.id]: [...seeded, ...synthetic] }
      })
    }, SEEDED_WORKSPACE_COUNT)

    await orcaPage.getByRole('button', { name: 'Workspace board' }).click()

    const cards = orcaPage.locator('[data-workspace-board-card-id]')
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(3)

    const readMaxIndex = (): Promise<number> =>
      cards.evaluateAll((elements) =>
        Math.max(
          ...elements.map((element) =>
            Number((element as HTMLElement).dataset.workspaceBoardCardIndex ?? -1)
          )
        )
      )
    const before = await readMaxIndex()

    await orcaPage
      .locator('[data-workspace-status="in-progress"] [data-workspace-board-lane-scroll]')
      .first()
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
      })

    await expect.poll(readMaxIndex, { timeout: 15_000 }).toBeGreaterThan(before)
  })

  test('selects the full lane across a single large marquee scroll jump', async ({ orcaPage }) => {
    const statusId = 'virtual-marquee'
    await orcaPage.evaluate(
      ({ count, status }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        const repo = state.repos[0]
        if (!repo) {
          throw new Error('Expected a seeded e2e repo')
        }
        const now = Date.now()
        const seeded = state.worktreesByRepo[repo.id] ?? []
        const synthetic = Array.from({ length: count }, (_, index) => ({
          id: `${repo.id}::/virtual-marquee-${index}`,
          instanceId: `virtual-marquee-${index}`,
          repoId: repo.id,
          path: `${repo.path}/../virtual-marquee-${index}`,
          displayName: `Virtual marquee ${index}`,
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 10_000 - index,
          manualOrder: 10_000 - index,
          lastActivityAt: now - index - 100,
          head: '0000000000000000000000000000000000000000',
          branch: `virtual-marquee-${index}`,
          isBare: false,
          isMainWorktree: false,
          workspaceStatus: status
        }))

        state.setSidebarOpen(true)
        state.setShowSleepingWorkspaces(true)
        state.setFilterRepoIds([])
        store.setState({
          sortBy: 'manual',
          worktreesByRepo: { ...state.worktreesByRepo, [repo.id]: [...seeded, ...synthetic] }
        })
        state.setWorkspaceStatuses([
          { id: status, label: 'Virtual marquee' },
          ...state.workspaceStatuses.filter((entry) => entry.id !== status)
        ])
      },
      { count: MARQUEE_WORKSPACE_COUNT, status: statusId }
    )

    await orcaPage.getByRole('button', { name: 'Workspace board' }).click()

    const lane = orcaPage.locator(`[data-workspace-status="${statusId}"]`)
    await expect(lane.getByText(String(MARQUEE_WORKSPACE_COUNT), { exact: true })).toBeVisible()
    const laneCards = lane.locator('[data-workspace-board-card-id]')
    await expect.poll(() => laneCards.count(), { timeout: 15_000 }).toBeGreaterThan(3)
    const laneScroll = lane.locator('[data-workspace-board-lane-scroll]')
    const box = await laneScroll.boundingBox()
    if (!box) {
      throw new Error('Expected the marquee lane to have a bounding box')
    }

    await orcaPage.mouse.move(box.x + 2, box.y + 12)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(box.x + box.width - 18, box.y + 80)
    await laneScroll.evaluate(async (element) => {
      for (let pass = 0; pass < 4; pass++) {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
      }
    })
    await orcaPage.mouse.move(box.x + box.width - 18, box.y + box.height - 12)
    await orcaPage.mouse.up()

    await expect(
      orcaPage.getByText(`${MARQUEE_WORKSPACE_COUNT} selected`, { exact: true })
    ).toBeVisible()
  })
})
