import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process'
import { test, expect } from './helpers/orca-app'
import { createSeededTestRepo } from './helpers/seeded-test-repo'
import { cleanupTestRepository } from './global-teardown'
import { worktreeRow } from './worktree-row-locators'
import { createRestartSession } from './helpers/orca-restart'
import type { ElectronApplication } from '@stablyai/playwright-test'

test.use({ seedTestRepo: false })

test('nests two repository worktrees under their folder and toggles both children', async ({
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  let ownedApp: ElectronApplication | undefined
  try {
    const launch = await session.launch()
    ownedApp = launch.app
    const electronApp = launch.app
    const orcaPage = launch.page
    await orcaPage.waitForFunction(
      () => window.__store?.getState().startupWorktreeRefreshCompleted === true,
      null,
      { timeout: 60_000 }
    )
    const secondRepo = createSeededTestRepo({ publishPath: false })
    registerPostElectronShutdownCleanup(async () => cleanupTestRepository(secondRepo))
    const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const context = await orcaPage.evaluate(
      async (repoPaths) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const repoIds: string[] = []
        for (const repoPath of repoPaths) {
          const result = await window.api.repos.add({ path: repoPath })
          if ('error' in result) {
            throw new Error(result.error)
          }
          repoIds.push(result.repo.id)
        }
        const group = await window.api.projectGroups.create({
          name: 'Folder nesting group',
          parentPath: repoPaths[0]
        })
        for (const repoId of repoIds) {
          await window.api.projectGroups.moveProject({ projectId: repoId, groupId: group.id })
        }
        const folder = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          name: 'Folder nesting ticket'
        })
        return { folderId: folder.id, repoIds }
      },
      [seededRepoPath, secondRepo]
    )

    for (const [index, repoId] of context.repoIds.entries()) {
      const result = await runProcess({
        program: process.execPath,
        args: [
          path.join(process.cwd(), 'out', 'cli', 'index.js'),
          'worktree',
          'create',
          '--repo',
          `id:${repoId}`,
          '--name',
          `folder-child-${index + 1}`,
          '--no-parent',
          '--setup',
          'skip',
          '--json'
        ],
        env: {
          ...process.env,
          ORCA_USER_DATA_PATH: userDataPath,
          ORCA_DEV_USER_DATA_PATH: userDataPath,
          ORCA_BACKGROUND_LAUNCH: '1'
        }
      })
      expect(result.code, result.stderr || result.stdout).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true })
    }

    const children = await orcaPage.evaluate(async ({ repoIds }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      const state = store.getState()
      await state.fetchRepos()
      await state.fetchProjectGroups()
      await state.fetchFolderWorkspaces()
      for (const repoId of repoIds) {
        await state.fetchWorktrees(repoId)
      }
      await state.fetchWorktreeLineage()
      state.setActiveView('terminal')
      state.setSidebarOpen(true)
      state.setGroupBy('none')
      state.setShowActiveOnly(false)
      state.setShowSleepingWorkspaces(true)
      state.setHideDefaultBranchWorkspace(false)
      state.setFilterRepoIds([])
      return Object.values(store.getState().worktreesByRepo)
        .flat()
        .filter(
          (worktree) =>
            repoIds.includes(worktree.repoId) && /folder-child-[12]$/u.test(worktree.path)
        )
        .map((worktree) => {
          const id = worktree.id
          const repo = store.getState().repos.find((row) => row.id === worktree.repoId)
          if (!repo) {
            throw new Error('Attached child repository unavailable')
          }
          return {
            id,
            repoName: repo.displayName,
            branch: worktree.branch.replace(/^refs\/heads\//u, '')
          }
        })
    }, context)
    const childIds = children.map((child) => child.id)
    expect(childIds).toHaveLength(2)
    const attachThroughSidebar = async (
      childId: string,
      folderName: string,
      keyboard = false
    ): Promise<void> => {
      await worktreeRow(orcaPage, childId).click({ button: 'right' })
      await orcaPage
        .getByRole('menuitem', { name: 'Attach to Folder Workspace…', exact: true })
        .click()
      const picker = orcaPage.locator('[data-folder-parent-picker]')
      await expect(picker).toBeVisible()
      const search = picker.getByRole('combobox')
      await expect(search).toBeFocused()
      await search.fill(folderName)
      const destination = picker.getByRole('option').filter({ hasText: folderName })
      await expect(destination).toHaveCount(1)
      await (keyboard ? search.press('Enter') : destination.click())
      await expect(picker).toBeHidden()
    }
    const originalChildren = await orcaPage.evaluate(
      (ids) =>
        Object.values(window.__store?.getState().worktreesByRepo ?? {})
          .flat()
          .filter((row) => ids.includes(row.id))
          .map((row) => ({ id: row.id, identity: row.identity?.key, branch: row.branch })),
      childIds
    )
    await orcaPage.evaluate(async (id) => {
      const state = window.__store?.getState()
      const child = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((row) => row.id === id)
      const parent = Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((row) => row.repoId === child?.repoId && row.isMainWorktree)
      if (!state || !child || !parent) {
        throw new Error('Git parent fixture unavailable')
      }
      await state.assignWorktreeParent(child.id, { parentWorktreeId: parent.id })
    }, childIds[0])
    await worktreeRow(orcaPage, childIds[0]).click({ button: 'right' })
    await orcaPage
      .getByRole('menuitem', { name: 'Attach to Folder Workspace…', exact: true })
      .click()
    await expect(
      orcaPage.locator('[data-folder-parent-picker]').getByRole('combobox')
    ).toBeFocused()
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.locator('[data-folder-parent-picker]')).toBeHidden()
    for (const childId of childIds) {
      await attachThroughSidebar(childId, 'Folder nesting ticket')
    }
    await expect
      .poll(() =>
        orcaPage.evaluate((id) => window.__store?.getState().worktreeLineageById[id], childIds[0])
      )
      .toBeUndefined()
    const folder = worktreeRow(orcaPage, `folder:${context.folderId}`)
    const toggle = folder.getByRole('button', { name: 'Hide 2 child workspaces', exact: true })
    await expect(toggle).toBeVisible()
    for (const childId of childIds) {
      const child = worktreeRow(orcaPage, childId)
      await expect(child).toBeVisible()
      const parentBox = await folder.boundingBox()
      const childBox = await child.boundingBox()
      expect(parentBox && childBox && childBox.y > parentBox.y).toBe(true)
    }
    for (const groupBy of ['none', 'repo'] as const) {
      await orcaPage.evaluate((mode) => window.__store?.getState().setGroupBy(mode), groupBy)
      for (const child of children) {
        const row = worktreeRow(orcaPage, child.id)
        await expect(row.locator('[data-worktree-title-inline-rename]')).toContainText(
          `${child.repoName}/`
        )
        const metadata = row.locator('[data-worktree-card-meta-row]')
        await expect(metadata.getByText(child.repoName, { exact: true })).toHaveCount(0)
        await expect(metadata.getByText(child.branch, { exact: true })).toHaveCount(0)
        await row.locator('[data-worktree-card-hover-trigger]').hover()
        await expect(
          orcaPage
            .locator('[data-worktree-hover-identity-header]')
            .getByText(child.branch, { exact: true })
        ).toBeVisible()
        await expect(orcaPage.locator('[data-slot="hover-card-content"]:visible')).toHaveCount(1)
        await orcaPage.mouse.move(1000, 20)
      }
    }
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    try {
      const screenshot = await cdp.send('Page.captureScreenshot')
      writeFileSync(
        testInfo.outputPath('folder-workspace-nesting.png'),
        Buffer.from(screenshot.data, 'base64')
      )
    } finally {
      await cdp.detach()
    }
    await toggle.click()
    for (const childId of childIds) {
      await expect(worktreeRow(orcaPage, childId)).toBeHidden()
    }
    await folder.getByRole('button', { name: 'Show 2 child workspaces', exact: true }).click()
    for (const childId of childIds) {
      await expect(worktreeRow(orcaPage, childId)).toBeVisible()
    }
    await orcaPage.locator('[data-workspace-board-trigger]').click()
    await expect(
      orcaPage.locator(`[data-workspace-board-worktree-id="folder:${context.folderId}"]`)
    ).toBeVisible()
    for (const childId of childIds) {
      await expect
        .poll(() =>
          orcaPage
            .locator('[data-workspace-board-worktree-id]')
            .evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute('data-workspace-board-worktree-id'))
            )
        )
        .not.toContain(childId)
    }
    await orcaPage.locator('[data-workspace-board-trigger]').click()
    const secondFolderId = await orcaPage.evaluate(async (folderId) => {
      const state = window.__store?.getState()
      const current = state?.folderWorkspaces.find((row) => row.id === folderId)
      if (!current) {
        throw new Error('Folder unavailable')
      }
      const created = await window.api.folderWorkspaces.create({
        projectGroupId: current.projectGroupId,
        name: 'Second folder'
      })
      await state?.fetchFolderWorkspaces()
      return created.id
    }, context.folderId)
    await attachThroughSidebar(childIds[0], 'Second folder', true)
    await expect(
      worktreeRow(orcaPage, `folder:${secondFolderId}`).getByRole('button', {
        name: 'Hide 1 child workspace'
      })
    ).toBeVisible()
    await worktreeRow(orcaPage, childIds[0]).click({ button: 'right' })
    await orcaPage
      .getByRole('menuitem', { name: 'Remove from Folder Workspace', exact: true })
      .click()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (id) => window.__store?.getState().workspaceLineageByChildKey[`worktree:${id}`],
          childIds[0]
        )
      )
      .toBeUndefined()
    const before = await orcaPage.evaluate(
      (ids) =>
        Object.values(window.__store?.getState().worktreesByRepo ?? {})
          .flat()
          .filter((row) => ids.includes(row.id))
          .map((row) => ({ id: row.id, identity: row.identity?.key, branch: row.branch })),
      childIds
    )
    expect(before).toEqual(originalChildren)
    await session.close(electronApp)
    ownedApp = undefined
    const restarted = await session.launch()
    ownedApp = restarted.app
    await restarted.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true
    )
    await expect
      .poll(() =>
        restarted.page.evaluate(
          (id) =>
            window.__store?.getState().workspaceLineageByChildKey[`worktree:${id}`]
              ?.parentWorkspaceKey,
          childIds[1]
        )
      )
      .toBe(`folder:${context.folderId}`)
    await expect
      .poll(() =>
        restarted.page.evaluate(
          (ids) =>
            Object.values(window.__store?.getState().worktreesByRepo ?? {})
              .flat()
              .filter((row) => ids.includes(row.id))
              .map((row) => ({ id: row.id, identity: row.identity?.key, branch: row.branch }))
              .toSorted((left, right) => left.id.localeCompare(right.id)),
          childIds
        )
      )
      .toEqual(before.toSorted((left, right) => left.id.localeCompare(right.id)))
    expect(
      await restarted.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  } finally {
    if (ownedApp) {
      await session.close(ownedApp)
    }
    await session.dispose()
  }
})
