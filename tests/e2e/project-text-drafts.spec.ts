import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('keeps project text drafts through switching, reload and cancelled Save, then saves the selected file', async ({
  orcaPage,
  electronApp,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const initialFiles = readdirSync(testRepoPath).sort()
  const originalWorkspace = await orcaPage.evaluate(
    () => window.__store!.getState().activeWorktreeId!
  )
  const otherProject = mkdtempSync(path.join(os.tmpdir(), 'orca-drafts-other-project-'))
  execFileSync('git', ['init', otherProject], { stdio: 'pipe' })
  registerPostElectronShutdownCleanup(async () =>
    rmSync(otherProject, { recursive: true, force: true })
  )

  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).first().click()
  await expect(orcaPage.getByRole('menuitem', { name: 'New File', exact: true })).toBeVisible()
  await orcaPage.getByRole('menu').screenshot({ path: testInfo.outputPath('new-file-menu.png') })
  await orcaPage.getByRole('menuitem', { name: 'New File', exact: true }).click()
  const editor = orcaPage.locator('.monaco-editor').filter({ visible: true }).first()
  await expect(editor).toBeVisible()
  await editor.click({ position: { x: 120, y: 20 } })
  await orcaPage.keyboard.type('Project A scratch text')
  await expect(editor).toContainText('Project A scratch text')
  await expect.poll(() => readdirSync(testRepoPath).sort()).toEqual(initialFiles)

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const projectId = state.getKnownWorktreeById(state.activeWorktreeId!)!.repoId
    const secondary = state
      .allWorktrees()
      .find((workspace) => workspace.repoId === projectId && !workspace.isMainWorktree)
    if (!secondary) {
      throw new Error('Second worktree is missing')
    }
    state.setActiveWorktree(secondary.id)
  })
  await expect(editor).toContainText('Project A scratch text')
  await editor.click({ position: { x: 120, y: 20 } })
  await orcaPage.keyboard.press('ControlOrMeta+a')
  await orcaPage.keyboard.type('Project A scratch text synced')
  await orcaPage.evaluate(
    (workspaceId) => window.__store!.getState().setActiveWorktree(workspaceId),
    originalWorkspace
  )
  await expect(editor).toContainText('Project A scratch text synced')

  await orcaPage.evaluate(async (repoPath) => {
    const state = window.__store!.getState()
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    await state.fetchReposForAllHosts()
    await state.fetchWorktrees(result.repo.id, { forceLocalOwner: true })
    const workspace = window.__store!.getState().worktreesByRepo[result.repo.id]?.[0]
    if (!workspace) {
      throw new Error('Second project is missing')
    }
    window.__store!.getState().setActiveRepo(result.repo.id)
    window.__store!.getState().setActiveWorktree(workspace.id)
    window.__store!.getState().openNewProjectTextDraft()
  }, otherProject)
  await expect(editor).not.toContainText('Project A scratch text synced')
  await editor.click({ position: { x: 120, y: 20 } })
  await orcaPage.keyboard.type('Project B separate text')
  await expect(editor).toContainText('Project B separate text')

  await orcaPage.evaluate(
    (workspaceId) => window.__store!.getState().setActiveWorktree(workspaceId),
    originalWorkspace
  )
  await expect(editor).toContainText('Project A scratch text synced')
  await expect(editor).not.toContainText('Project B separate text')
  await orcaPage.screenshot({ path: testInfo.outputPath('project-text-draft.png') })

  await Promise.all([
    orcaPage.waitForEvent('domcontentloaded'),
    orcaPage.evaluate(() => {
      void window.api.app.reload()
    })
  ])
  await waitForSessionReady(orcaPage)
  await expect(editor).toContainText('Project A scratch text synced', { timeout: 25_000 })

  await electronApp.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })
  })
  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect(editor).toContainText('Project A scratch text synced')
  expect(readdirSync(testRepoPath).sort()).toEqual(initialFiles)

  const destination = path.join(testRepoPath, 'saved-scratch.txt')
  await electronApp.evaluate(({ dialog }, destinationPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destinationPath })
  }, destination)
  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect
    .poll(() => (existsSync(destination) ? readFileSync(destination, 'utf8') : null))
    .toBe('Project A scratch text synced')
  await expect(
    orcaPage.locator('[data-tab-id]').filter({ hasText: 'saved-scratch.txt' }).last()
  ).toBeVisible()
  await expect(editor).toContainText('Project A scratch text synced')
})
