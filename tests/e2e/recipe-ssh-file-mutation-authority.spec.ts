import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import './helpers/runtime-types'
import {
  createRecipeSshFileFixture,
  readRecipeSshFixtureKnownHost,
  readRecipeSshFixtureTarget,
  RECIPE_SSH_FIXTURE_ID,
  writeRecipeSshFileFixtureRecipe
} from './helpers/recipe-ssh-file-fixture'

const fixtureTargetPath = process.env.ORCA_RECIPE_SSH_FIXTURE_TARGET

test('Recipe SSH files save and Explorer creates files without registering a user host', async ({
  orcaPage,
  electronApp,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(!fixtureTargetPath, 'Requires an explicitly supplied, existing SSH scratch fixture')
  if (!fixtureTargetPath) {
    throw new Error('Missing SSH fixture target')
  }
  test.setTimeout(180_000)
  const target = readRecipeSshFixtureTarget(fixtureTargetPath)
  const remote = await createRecipeSshFileFixture(target)
  registerPostElectronShutdownCleanup(remote.cleanup)
  writeRecipeSshFileFixtureRecipe(testRepoPath, target, remote.remoteRoot)
  const trustedHost = await readRecipeSshFixtureKnownHost(target)
  const isolatedHome = await electronApp.evaluate(() => process.env.HOME)
  if (!isolatedHome) {
    throw new Error('Missing isolated Electron home')
  }
  mkdirSync(path.join(isolatedHome, '.ssh'), { recursive: true })
  writeFileSync(path.join(isolatedHome, '.ssh', 'known_hosts'), trustedHost)

  await orcaPage.waitForFunction(() => Boolean(window.__store))
  const provisioned = await orcaPage.evaluate(
    async ({ sourcePath, recipeId }) => {
      const added = await window.api.repos.add({ path: sourcePath })
      if ('error' in added) {
        throw new Error(added.error)
      }
      const result = await window.api.ephemeralVm.provision({ repoId: added.repo.id, recipeId })
      if (!result.ok) {
        throw new Error(result.error)
      }
      if (result.connectionType !== 'ssh') {
        throw new Error('Expected a real Recipe SSH session')
      }
      return { targetId: result.sshTargetId, runtimeId: result.runtime.id }
    },
    { sourcePath: testRepoPath, recipeId: RECIPE_SSH_FIXTURE_ID }
  )
  const remoteRepoId = await orcaPage.evaluate(
    async ({ targetId, remotePath }) => {
      const added = await window.api.repos.addRemote({
        connectionId: targetId,
        remotePath,
        displayName: 'Recipe SSH owned scratch'
      })
      if ('error' in added) {
        throw new Error(added.error)
      }
      return added.repo.id
    },
    { targetId: provisioned.targetId, remotePath: remote.remoteRoot }
  )
  await orcaPage.evaluate(
    async ({ repoId, remotePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing renderer store')
      }
      await store.getState().fetchRepos()
      const worktrees = await window.api.worktrees.list({ repoId })
      const worktree = worktrees.find((entry) => entry.path === remotePath)
      if (!worktree) {
        throw new Error('Missing remote fixture worktree')
      }
      store.setState({
        worktreesByRepo: { ...store.getState().worktreesByRepo, [repoId]: worktrees }
      })
      store.getState().setActiveRepo(repoId)
      store.getState().setActiveWorktree(worktree.id)
      store.getState().setRightSidebarTab('explorer')
      store.getState().setRightSidebarOpen(true)
    },
    { repoId: remoteRepoId, remotePath: remote.remoteRoot }
  )

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  const fileRow = explorer.locator('[data-file-explorer-row]').filter({
    has: orcaPage
      .locator('[data-file-explorer-row-name]')
      .getByText('authority.txt', { exact: true })
  })
  await expect(fileRow).toBeVisible({ timeout: 20_000 })
  await fileRow.click()
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('authority.txt')
  const editor = orcaPage.locator('.monaco-editor').first()
  await expect(editor.locator('.view-lines')).toContainText('Recipe fixture original', {
    timeout: 20_000
  })
  const sentinel = `Recipe SSH saved ${Date.now()}`
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.type(sentinel)
  await orcaPage.keyboard.press('ControlOrMeta+S')
  await expect.poll(remote.readFile, { timeout: 15_000 }).toContain(sentinel)

  const fileTab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'authority.txt' }).last()
  await fileTab.getByRole('button', { name: 'Close tab' }).click()
  await expect(
    orcaPage.locator('.editor-header-path').filter({ hasText: 'authority.txt' })
  ).toHaveCount(0)
  await orcaPage.getByRole('option').filter({ hasText: provisioned.targetId }).click()
  await expect(fileRow).toBeVisible({ timeout: 15_000 })
  await fileRow.click()
  await expect(orcaPage.locator('.monaco-editor .view-lines').first()).toContainText(sentinel, {
    timeout: 20_000
  })

  const explorerBounds = await explorer.boundingBox()
  if (!explorerBounds) {
    throw new Error('Missing Explorer bounds')
  }
  await explorer.click({ button: 'right', position: { x: 30, y: explorerBounds.height - 30 } })
  await orcaPage.getByRole('menuitem', { name: 'New File', exact: true }).click()
  const newFileInput = explorer.locator('input:not([placeholder])')
  await expect(newFileInput).toBeVisible()
  await newFileInput.fill('explorer-created.txt')
  await newFileInput.press('Enter')
  const createdRow = explorer
    .locator('[data-file-explorer-row-name]')
    .getByText('explorer-created.txt', { exact: true })
  await expect(createdRow).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => remote.fileExists('explorer-created.txt')).toBe(true)
  await fileRow.click()
  await expect(orcaPage.locator('.monaco-editor .view-lines').first()).toContainText(sentinel)
  await testInfo.attach('recipe-ssh-save-and-create', {
    body: await orcaPage.screenshot({ path: process.env.ORCA_RECIPE_SSH_SCREENSHOT_PATH }),
    contentType: 'image/png'
  })

  const registeredTargetIds = await orcaPage.evaluate(async () =>
    (await window.api.ssh.listTargets()).map((entry) => entry.id)
  )
  expect(registeredTargetIds).not.toContain(provisioned.targetId)
  await orcaPage.evaluate(
    async ({ runtimeId }) => window.api.ephemeralVm.cleanup({ runtimeId }),
    provisioned
  )
  await expect(createdRow).toBeVisible()
})
