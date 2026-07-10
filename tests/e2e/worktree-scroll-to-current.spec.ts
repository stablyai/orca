import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function prepareSidebarForScrollTest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('recent')
    state.setShowActiveOnly(false)
    state.setShowSleepingWorkspaces(true)
    state.setHideDefaultBranchWorkspace(false)
    state.setFilterRepoIds([])
  })
}

test.describe('Reveal active workspace button', () => {
  test.beforeEach(async ({ orcaPage }) => {
    // Sidebar reveal now always jumps instantly (worktree-sidebar-reveal.ts
    // assigns scrollTop directly), so no reduced-motion emulation is needed
    // for the geometry assertions to be deterministic.
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  // Note: the "clipped in the production sidebar" pixel-containment test was
  // removed — it forced a ~44px synthetic viewport and asserted ±1px scroll
  // precision, which the row virtualizer can't guarantee under CI saturation
  // (not a scenario real users hit). Reveal-into-view is covered robustly by
  // the "outside the virtualized window" test below.

  test('clears sidebar filters before revealing a hidden current workspace', async ({
    orcaPage
  }) => {
    await prepareSidebarForScrollTest(orcaPage)

    const renderedOptions = orcaPage.locator('[data-worktree-sidebar] [role="option"]')
    await expect(renderedOptions).toHaveCount(2)

    const targetId = await renderedOptions.last().getAttribute('data-worktree-id')
    if (!targetId) {
      throw new Error('Bottom workspace row did not expose a data-worktree-id')
    }

    const targetRows = orcaPage.locator(
      `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
    )
    const targetRow = targetRows.first()
    const revealButton = orcaPage.getByRole('button', { name: 'Reveal active workspace' })

    await orcaPage.evaluate((targetId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const target = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === targetId)
      if (!target) {
        throw new Error(`Target workspace ${targetId} not found`)
      }
      store.setState({
        activeRepoId: target.repoId,
        activeWorktreeId: target.id,
        activeWorkspaceKey: `worktree:${target.id}`,
        pendingRevealWorktree: null
      })
    }, targetId)
    await expect(targetRow).toHaveAttribute('aria-current', 'page')

    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().setFilterRepoIds(['__filtered_repo__'])
    })

    // Why: the filter's row-hiding side effect is covered deterministically by
    // visible-worktrees.test.ts. Asserting an empty DOM here over-specifies an
    // incidental render-settle state that flakes under the shared page; the
    // contract under test is that reveal clears the filter (asserted below).

    await revealButton.click()

    await expect(targetRow).toBeVisible()
    await expect(targetRow).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            return store.getState().filterRepoIds
          }),
        {
          timeout: 10_000,
          message: 'Reveal button should clear repo filters that hide the current workspace'
        }
      )
      .toEqual([])
  })

  test('reveals the current workspace when it starts outside the virtualized window', async ({
    orcaPage
  }) => {
    await prepareSidebarForScrollTest(orcaPage)

    const targetId = await orcaPage.evaluate(() => {
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
      const seededWorktrees = state.worktreesByRepo[repo.id] ?? []
      const syntheticWorktrees = Array.from({ length: 60 }, (_, index) => {
        const suffix = String(index).padStart(2, '0')
        return {
          id: `${repo.id}::/virtual-reveal-${suffix}`,
          instanceId: `virtual-reveal-${suffix}`,
          repoId: repo.id,
          path: `${repo.path}/../virtual-reveal-${suffix}`,
          displayName: `Virtual reveal ${suffix}`,
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
          branch: `virtual-reveal-${suffix}`,
          isBare: false,
          isMainWorktree: false
        }
      })
      const target = syntheticWorktrees.at(-1)
      if (!target) {
        throw new Error('Expected a synthetic target worktree')
      }

      store.setState({
        activeRepoId: repo.id,
        activeWorktreeId: target.id,
        activeWorkspaceKey: `worktree:${target.id}`,
        pendingRevealWorktree: null,
        sortBy: 'manual',
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [repo.id]: [...seededWorktrees, ...syntheticWorktrees]
        }
      })
      return target.id
    })

    const scroller = orcaPage.locator('[data-worktree-sidebar]')
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
            return scroller?.scrollTop ?? null
          }),
        { timeout: 10_000, message: 'sidebar scroller did not mount' }
      )
      .not.toBeNull()

    await scroller.evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await expect
      .poll(
        () =>
          orcaPage.evaluate((targetId) => {
            const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
            const target = [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
              (candidate) => candidate.dataset.worktreeId === targetId
            )
            if (!scroller || !target) {
              return false
            }
            const scrollerBounds = scroller.getBoundingClientRect()
            const targetBounds = target.getBoundingClientRect()
            return (
              targetBounds.top >= scrollerBounds.top - 1 &&
              targetBounds.bottom <= scrollerBounds.bottom + 1
            )
          }, targetId),
        { timeout: 10_000, message: 'target workspace should start outside the sidebar viewport' }
      )
      .toBe(false)

    const revealButton = orcaPage.getByRole('button', { name: 'Reveal active workspace' })
    await expect(revealButton).toBeVisible()
    await expect(revealButton).toBeEnabled()

    await revealButton.click()
    const targetRow = orcaPage
      .locator(`[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`)
      .first()
    await expect(targetRow).toBeVisible()
    await expect(targetRow).toHaveAttribute('data-scroll-reveal-highlight', 'true')
  })

  test('uses the active workspace key when the legacy active worktree id is not set', async ({
    orcaPage
  }) => {
    await prepareSidebarForScrollTest(orcaPage)

    const folderWorktreeId = await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const now = Date.now()
      const folderWorkspaces = Array.from({ length: 36 }, (_, index) => {
        const suffix = String(index).padStart(2, '0')
        return {
          id: `reveal-folder-workspace-${suffix}`,
          projectGroupId: 'reveal-folder-group',
          name: `Reveal folder workspace ${suffix}`,
          folderPath: `/tmp/reveal-folder-workspace-${suffix}`,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1_000 - index,
          lastActivityAt: now - index,
          createdAt: now,
          updatedAt: now
        }
      })
      const targetFolder = folderWorkspaces.at(-1)
      if (!targetFolder) {
        throw new Error('Expected a target folder workspace')
      }
      const folderWorktreeId = `folder:${targetFolder.id}`
      store.setState({
        activeRepoId: null,
        activeWorktreeId: null,
        activeWorkspaceKey: folderWorktreeId,
        projectGroups: [
          {
            id: 'reveal-folder-group',
            name: 'Reveal folder group',
            parentPath: '/tmp/reveal-folder-group',
            parentGroupId: null,
            createdFrom: 'manual',
            tabOrder: 1,
            isCollapsed: false,
            color: null,
            createdAt: now,
            updatedAt: now
          }
        ],
        folderWorkspaces
      })
      store.getState().setGroupBy('repo')
      return folderWorktreeId
    })

    const scroller = orcaPage.locator('[data-worktree-sidebar]')
    await scroller.evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await expect
      .poll(
        () =>
          orcaPage.evaluate((targetId) => {
            const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
            const target = [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
              (candidate) => candidate.dataset.worktreeId === targetId
            )
            if (!scroller || !target) {
              return false
            }
            const scrollerBounds = scroller.getBoundingClientRect()
            const targetBounds = target.getBoundingClientRect()
            return (
              targetBounds.top >= scrollerBounds.top - 1 &&
              targetBounds.bottom <= scrollerBounds.bottom + 1
            )
          }, folderWorktreeId),
        { timeout: 10_000, message: 'target folder workspace should start outside the viewport' }
      )
      .toBe(false)

    const revealButton = orcaPage.getByRole('button', { name: 'Reveal active workspace' })
    await expect(revealButton).toBeVisible()
    await expect(revealButton).toBeEnabled()
    await revealButton.click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate((targetId) => {
            const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
            const target = [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
              (candidate) => candidate.dataset.worktreeId === targetId
            )
            if (!scroller || !target) {
              return false
            }
            const scrollerBounds = scroller.getBoundingClientRect()
            const targetBounds = target.getBoundingClientRect()
            return (
              targetBounds.top >= scrollerBounds.top - 1 &&
              targetBounds.bottom <= scrollerBounds.bottom + 1
            )
          }, folderWorktreeId),
        {
          timeout: 10_000,
          message: 'Reveal button should scroll to the active folder workspace'
        }
      )
      .toBe(true)
  })
})
