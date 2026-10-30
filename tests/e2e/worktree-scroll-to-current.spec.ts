import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { evaluatePolled } from './helpers/page-evaluate-polled'
import {
  addRepoWithWorkspaces,
  bulkWriteTimeout,
  writeWorkspaceMeta
} from './helpers/repo-with-workspaces'
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
    // Reduced motion jumps reveal deterministically because hidden xvfb Electron never advances smooth-scroll animations.
    await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  // Use outside-virtual-window reveal coverage; a removed ~44px synthetic viewport/±1px containment test was unstable under saturated CI.

  test('adjusts sidebar filters before revealing a hidden current workspace', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const filterRepoPath = testInfo.outputPath('filter-repo')
    mkdirSync(filterRepoPath, { recursive: true })
    for (const args of [
      ['init', filterRepoPath],
      [
        '-C',
        filterRepoPath,
        '-c',
        'user.name=E2E',
        '-c',
        'user.email=e2e@test.local',
        'commit',
        '--allow-empty',
        '-m',
        'Filter fixture'
      ]
    ]) {
      const result = await runProcess({ program: 'git', args })
      expect(result.code, result.stderr).toBe(0)
    }
    const filterRepoId = await orcaPage.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, filterRepoPath)
    await expect
      .poll(() =>
        orcaPage.evaluate(async (id) => {
          await window
            .__store!.getState()
            .fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          return window.__store!.getState().repos.some((repo) => repo.id === id)
        }, filterRepoId)
      )
      .toBe(true)
    await prepareSidebarForScrollTest(orcaPage)

    // Other specs can add worktrees to the shared repository before this test runs.
    const targetId = await orcaPage.evaluate((repoPath) => {
      const state = window.__store!.getState()
      const repo = state.repos.find((candidate) => candidate.path === repoPath)
      return repo
        ? state.worktreesByRepo[repo.id]?.find(
            (worktree) => worktree.branch === 'refs/heads/e2e-secondary'
          )?.id
        : undefined
    }, testRepoPath)
    if (!targetId) {
      throw new Error('Seeded secondary worktree is missing')
    }
    const targetRepoId = await orcaPage.evaluate(
      (repoPath) => window.__store!.getState().repos.find((repo) => repo.path === repoPath)?.id,
      testRepoPath
    )
    if (!targetRepoId) {
      throw new Error('Seeded repository is missing')
    }

    const targetRows = orcaPage.locator(
      `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
    )
    const targetRow = targetRows.first()
    await expect(targetRows.and(orcaPage.getByRole('option'))).toHaveCount(1)
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

    // Catalog refreshes prune nonexistent IDs, so use a real repo to keep the filter applied.
    await orcaPage.evaluate((repoId) => {
      window.__store!.getState().setFilterRepoIds([repoId])
    }, filterRepoId)
    await expect(targetRows).toHaveCount(0)

    await revealButton.click()
    await orcaPage
      .getByRole('dialog', { name: 'Reveal hidden workspace?' })
      .getByRole('button', { name: 'Adjust filters and reveal' })
      .click()

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
          message:
            'Reveal button should preserve selected repos while revealing the current workspace'
        }
      )
      .toEqual([filterRepoId, targetRepoId])
  })

  test('reveals the current workspace when it starts outside the virtualized window', async ({
    orcaPage
  }, testInfo) => {
    await prepareSidebarForScrollTest(orcaPage)

    const repo = await addRepoWithWorkspaces(orcaPage, testInfo, 60)
    await writeWorkspaceMeta(
      orcaPage,
      repo.ids.map((worktreeId, index) => ({
        worktreeId,
        updates: {
          displayName: `Virtual reveal ${String(index).padStart(2, '0')}`,
          sortOrder: 10_000 - index,
          manualOrder: 10_000 - index
        }
      }))
    )
    const targetId = repo.ids.at(-1)!
    await orcaPage.evaluate(
      ({ repoId, targetId }) => {
        window.__store!.setState({
          activeRepoId: repoId,
          activeWorktreeId: targetId,
          activeWorkspaceKey: `worktree:${targetId}`,
          pendingRevealWorktree: null,
          sortBy: 'manual'
        })
      },
      { repoId: repo.repoId, targetId }
    )

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
  }, testInfo) => {
    await prepareSidebarForScrollTest(orcaPage)

    // The oldest of 36 folder workspaces sorts last under Recent.
    const groupPath = testInfo.outputPath('reveal-folder-group')
    const folderPaths = Array.from({ length: 36 }, (_, index) => {
      const folderPath = path.join(groupPath, `folder-${String(index).padStart(2, '0')}`)
      mkdirSync(folderPath, { recursive: true })
      return realpathSync(folderPath)
    })
    const folderWorktreeId = await evaluatePolled(
      orcaPage,
      async ({ parentPath, folderPaths }) => {
        const store = window.__store!
        const group = await window.api.projectGroups.create({
          name: 'Reveal folder group',
          parentPath,
          createdFrom: 'manual'
        })
        await store
          .getState()
          .fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
        const ids: string[] = []
        for (const [index, folderPath] of folderPaths.entries()) {
          const folder = await store.getState().createFolderWorkspace(
            {
              projectGroupId: group.id,
              name: `Reveal folder workspace ${String(index).padStart(2, '0')}`,
              folderPath
            },
            { runtimeEnvironmentId: null }
          )
          if (!folder) {
            throw new Error(`Folder workspace ${index} was not created`)
          }
          ids.push(folder.id)
        }
        const targetKey = `folder:${ids[0]}` as const
        store.setState({
          activeRepoId: null,
          activeWorktreeId: null,
          activeWorkspaceKey: targetKey
        })
        store.getState().setGroupBy('repo')
        return targetKey
      },
      { parentPath: realpathSync(groupPath), folderPaths },
      { timeout: bulkWriteTimeout(folderPaths.length) }
    )

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
