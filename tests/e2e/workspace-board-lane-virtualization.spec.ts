import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const SEEDED_WORKSPACE_COUNT = 300
const MARQUEE_WORKSPACE_COUNT = 102
const MANY_LANE_COUNT = 21
const CARDS_PER_LANE = 100

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

  test('bounds mounted lanes and cards while preserving a 21-status workflow', async ({
    orcaPage
  }) => {
    const statusIds = Array.from(
      { length: MANY_LANE_COUNT },
      (_, index) => `state-${String(index + 1).padStart(2, '0')}`
    )
    await orcaPage.evaluate(
      ({ cardsPerLane, ids }) => {
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
        const synthetic = ids.flatMap((status, statusIndex) =>
          Array.from({ length: cardsPerLane }, (_, cardIndex) => {
            const suffix = `${String(statusIndex + 1).padStart(2, '0')}-${String(
              cardIndex + 1
            ).padStart(3, '0')}`
            return {
              id: `${repo.id}::/virtual-lane-${suffix}`,
              instanceId: `virtual-lane-${suffix}`,
              repoId: repo.id,
              path: `${repo.path}/../virtual-lane-${suffix}`,
              displayName: `Virtual lane ${suffix}`,
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 20_000 - statusIndex * cardsPerLane - cardIndex,
              manualOrder: 20_000 - statusIndex * cardsPerLane - cardIndex,
              lastActivityAt: now - statusIndex * cardsPerLane - cardIndex,
              head: '0000000000000000000000000000000000000000',
              branch: `virtual-lane-${suffix}`,
              isBare: false,
              isMainWorktree: false,
              workspaceStatus: status
            }
          })
        )

        state.setSidebarOpen(true)
        state.setShowSleepingWorkspaces(true)
        state.setHideDefaultBranchWorkspace(false)
        state.setFilterRepoIds([])
        state.setWorkspaceBoardColumnWidth(308)
        state.setWorkspaceStatuses(
          ids.map((id, index) => ({
            id,
            label: `State ${index + 1}`
          }))
        )
        store.setState({
          sortBy: 'manual',
          worktreesByRepo: { ...state.worktreesByRepo, [repo.id]: synthetic }
        })
      },
      { cardsPerLane: CARDS_PER_LANE, ids: statusIds }
    )

    await orcaPage.getByRole('button', { name: 'Workspace board' }).click()

    const board = orcaPage.locator('[data-workspace-board-selection-surface]')
    const scroller = board.locator('[data-workspace-board-lane-grid]').locator('..')
    const lanes = board.locator('[data-workspace-status]')
    const cards = board.locator('[data-workspace-board-card-id]')
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(3)

    const laneBudget = await scroller.evaluate(
      (element) => Math.ceil(element.clientWidth / 320) + 3
    )
    const initialLaneCount = await lanes.count()
    expect(initialLaneCount).toBeLessThanOrEqual(laneBudget)
    expect(await cards.count()).toBeLessThan(initialLaneCount * 40)
    expect(await board.locator('*').count()).toBeLessThan(initialLaneCount * 550 + 200)
    await expect(board.locator('[data-workspace-status="state-01"]')).toBeVisible()
    expect(await board.locator('[data-workspace-status="state-21"]').count()).toBe(0)

    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    await expect(board.locator('[data-workspace-status="state-21"]')).toBeVisible()
    await expect.poll(() => board.locator('[data-workspace-status="state-01"]').count()).toBe(0)
    const finalIds = await lanes.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.workspaceStatus ?? '')
    )
    expect(finalIds).toEqual([...finalIds].sort())
    expect(finalIds).toContain('state-21')
    expect(await lanes.count()).toBeLessThanOrEqual(laneBudget)
    expect(await cards.count()).toBeLessThan((await lanes.count()) * 40)
    expect(
      await orcaPage.evaluate(() =>
        window.__store?.getState().workspaceStatuses.map((status) => status.id)
      )
    ).toEqual(statusIds)

    const finalLane = board.locator('[data-workspace-status="state-21"]')
    const resizeHandle = finalLane.getByRole('separator', {
      name: 'Resize workspace board columns'
    })
    await resizeHandle.focus()
    await resizeHandle.press('ArrowRight')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().workspaceBoardColumnWidth))
      .toBe(328)
    await expect(resizeHandle).toHaveAttribute('aria-valuenow', '328')
    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await expect(finalLane).toBeVisible()

    const sourceCard = board
      .locator('[data-workspace-status="state-20"] [data-workspace-board-card-id]')
      .first()
    const sourceId = await sourceCard.getAttribute('data-workspace-board-worktree-id')
    const sourceBox = await sourceCard.boundingBox()
    const targetBox = await finalLane
      .locator('[data-workspace-board-lane-scroll]')
      .first()
      .boundingBox()
    if (!sourceId || !sourceBox || !targetBox) {
      throw new Error('Expected visible source card and final lane drop target')
    }
    await orcaPage.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(
      targetBox.x + targetBox.width / 2,
      targetBox.y + Math.min(80, targetBox.height / 2),
      { steps: 8 }
    )
    await orcaPage.mouse.up()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (worktreeId) =>
            window.__store?.getState().getKnownWorktreeById(worktreeId)?.workspaceStatus,
          sourceId
        )
      )
      .toBe('state-21')
  })

  test('selects the full lane across a single large marquee scroll jump', async ({ orcaPage }) => {
    test.skip(true, 'Quarantined by https://github.com/stablyai/orca/issues/12415')
    const statusId = 'virtual-marquee'
    const emptyStatusId = 'virtual-marquee-start'
    await orcaPage.evaluate(
      ({ count, emptyStatus, status }) => {
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
          { id: emptyStatus, label: 'Marquee start' },
          ...state.workspaceStatuses.filter(
            (entry) => entry.id !== status && entry.id !== emptyStatus
          )
        ])
      },
      { count: MARQUEE_WORKSPACE_COUNT, emptyStatus: emptyStatusId, status: statusId }
    )

    await orcaPage.getByRole('button', { name: 'Workspace board' }).click()

    const lane = orcaPage.locator(`[data-workspace-status="${statusId}"]`)
    await expect(lane.getByText(String(MARQUEE_WORKSPACE_COUNT), { exact: true })).toBeVisible()
    const laneCards = lane.locator('[data-workspace-board-card-id]')
    await expect.poll(() => laneCards.count(), { timeout: 15_000 }).toBeGreaterThan(3)
    const laneScroll = lane.locator('[data-workspace-board-lane-scroll]')
    const emptyLaneScroll = orcaPage.locator(
      `[data-workspace-status="${emptyStatusId}"] [data-workspace-board-lane-scroll]`
    )
    const box = await laneScroll.boundingBox()
    if (!box) {
      throw new Error('Expected the marquee lane to have a bounding box')
    }

    // Why: CI can overlay individual lane pixels, so choose a live board-owned point.
    const startPoint = await emptyLaneScroll.evaluate((element) => {
      const ignored = [
        '[data-workspace-board-card-id]',
        'a',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="menu"]',
        '[role="menuitem"]'
      ].join(',')
      const rect = element.getBoundingClientRect()
      for (let y = Math.ceil(rect.top) + 6; y <= Math.floor(rect.top) + 40; y += 6) {
        for (let x = Math.ceil(rect.left) + 8; x <= Math.floor(rect.right) - 8; x += 8) {
          const target = document.elementFromPoint(x, y)
          if (
            target?.closest('[data-workspace-board-selection-surface]') &&
            !target.closest(ignored)
          ) {
            return { x, y }
          }
        }
      }
      return null
    })
    expect(startPoint, 'the empty start lane must expose board-owned space').not.toBeNull()
    if (!startPoint) {
      throw new Error('Expected empty board space for the marquee start')
    }

    await orcaPage.mouse.move(startPoint.x, startPoint.y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(box.x + box.width - 18, box.y + 80, { steps: 4 })

    // Why: proves the board accepted the gesture. Without it a rejected
    // pointerdown only shows up 15s later as "0 cards previewed", which reads as
    // a virtualization bug rather than a marquee that never started.
    await expect(orcaPage.locator('[data-workspace-board-selection-rect]')).toBeVisible()
    await expect
      .poll(() => lane.locator('[data-workspace-board-card-area-selected="true"]').count(), {
        timeout: 15_000
      })
      .toBeGreaterThan(0)
    // Why: a measured card is much taller than the lane's row estimate, so each
    // jump to the bottom re-measures the window and grows the spacer past the
    // scrollTop the jump just landed on. A fixed pass budget commits the marquee
    // mid-growth on a loaded machine — short of the last cards — so jump until
    // the virtualizer stops moving the bottom instead.
    const laneScrollSettle = await laneScroll.evaluate(async (element) => {
      let settledPasses = 0
      let passes = 0
      while (settledPasses < 2 && passes < 40) {
        passes += 1
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
        const maxScrollTop = element.scrollHeight - element.clientHeight
        settledPasses = element.scrollTop >= maxScrollTop - 1 ? settledPasses + 1 : 0
      }
      return {
        passes,
        scrollTop: element.scrollTop,
        maxScrollTop: element.scrollHeight - element.clientHeight
      }
    })
    expect(
      laneScrollSettle.scrollTop,
      `lane scroll never settled at its bottom: ${JSON.stringify(laneScrollSettle)}`
    ).toBeGreaterThanOrEqual(laneScrollSettle.maxScrollTop - 1)

    await orcaPage.mouse.move(box.x + box.width - 18, box.y + box.height - 12)
    await orcaPage.mouse.up()

    // Why: assert the badge's text, not its presence — a marquee that stopped
    // short reports the count it did commit instead of a bare locator timeout.
    await expect(orcaPage.getByText(/^\d+ selected$/)).toHaveText(
      `${MARQUEE_WORKSPACE_COUNT} selected`
    )
  })
})
