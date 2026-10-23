import { runProcessSync } from '@orca/process-host'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Repo } from '../../src/shared/repo-types'
import { expect, test } from './helpers/orca-app'
import { createSeededTestRepo } from './helpers/seeded-test-repo'
import { cleanupTestRepository } from './global-teardown'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { waitForSessionReady } from './helpers/store'

test.use({
  seedTestRepo: false,
  orcaAppExtraArgs: process.env.ORCA_ROUTING_CDP_PORT
    ? [`--remote-debugging-port=${process.env.ORCA_ROUTING_CDP_PORT}`]
    : []
})

function git(repoPath: string, args: string[]): string {
  const result = runProcessSync({ program: 'git', args, cwd: repoPath })
  if (result.code !== 0 || result.signal || result.timedOut || result.outputTruncated) {
    throw new Error(`Git failed in ${repoPath}: ${JSON.stringify(result)}`)
  }
  return result.stdout.trim()
}

test('requires a checkout for an ambiguous project and creates in the explicitly chosen repository', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const checkoutA = createSeededTestRepo({ publishPath: false })
  const checkoutB = createSeededTestRepo({ publishPath: false })
  registerPostElectronShutdownCleanup(async () => {
    cleanupTestRepository(checkoutB)
    cleanupTestRepository(checkoutA)
  })
  for (const checkout of [checkoutA, checkoutB]) {
    git(checkout, ['branch', '-M', 'main'])
    git(checkout, ['remote', 'add', 'origin', 'https://github.com/orca-e2e/shared-routing.git'])
  }
  expect(realpathSync(path.join(checkoutA, '.git'))).not.toBe(
    realpathSync(path.join(checkoutB, '.git'))
  )

  const target = await orcaPage.evaluate(
    async ({ checkoutA, checkoutB }) => {
      const store = window.__store!
      await store.getState().updateSettingsOrThrow({ defaultTuiAgent: 'blank' })
      const repos: Repo[] = []
      for (const [index, checkout] of [checkoutA, checkoutB].entries()) {
        const result = await window.api.repos.add({ path: checkout })
        if ('error' in result) {
          throw new Error(result.error)
        }
        await window.api.repos.update({
          repoId: result.repo.id,
          updates: {
            displayName: index === 0 ? 'Routing checkout A' : 'Routing checkout B',
            worktreeBaseRef: 'main',
            worktreeBasePath: '.routing-workspaces'
          }
        })
        repos.push(result.repo)
      }
      await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
      for (const repo of repos) {
        await store.getState().fetchWorktrees(repo.id)
      }
      const state = store.getState()
      const setupA = state.projectHostSetups.find((setup) => setup.repoId === repos[0].id)
      const setupB = state.projectHostSetups.find((setup) => setup.repoId === repos[1].id)
      const mainA = state.worktreesByRepo[repos[0].id]?.find((worktree) => worktree.isMainWorktree)
      if (!setupA || !setupB || !mainA) {
        throw new Error('Independent checkout fixture did not produce ready project setups')
      }
      state.setActiveWorktree(null)
      state.setActiveRepo(null)
      return { repoA: repos[0].id, repoB: repos[1].id, setupA, setupB, mainA: mainA.id }
    },
    { checkoutA, checkoutB }
  )
  expect(target.setupA.projectId).toBe(target.setupB.projectId)
  expect(target.setupA.id).not.toBe(target.setupB.id)
  const fixtureIdentity = await electronApp.evaluate(({ app, BrowserWindow }) => ({
    appPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(fixtureIdentity.windows.length).toBeGreaterThan(0)
  expect(fixtureIdentity.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  const fixtureEvidencePath = testInfo.outputPath('routing-fixture.json')
  writeFileSync(
    fixtureEvidencePath,
    JSON.stringify({ ...fixtureIdentity, ...target, checkoutA, checkoutB }, null, 2)
  )
  await testInfo.attach('routing-fixture.json', {
    path: fixtureEvidencePath,
    contentType: 'application/json'
  })

  const composer = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  const create = composer.getByRole('button', { name: /Create (Workspace|Worktree)/i })
  const runTarget = composer.locator('div[data-run-target-combobox-root="true"]')
  const projectHint = { projectId: target.setupA.projectId, hostId: target.setupA.hostId }

  await orcaPage.evaluate(
    ({ repoId, projectHint }) => {
      window.__store!.getState().openModal('new-workspace-composer', {
        initialRepoId: repoId,
        initialWorkspaceTarget: projectHint,
        prefilledName: 'exact-checkout-control'
      })
    },
    { repoId: target.repoB, projectHint }
  )
  await expect(composer).toBeVisible()
  await expect(runTarget).toContainText(checkoutB)
  await expect(create).toBeEnabled()
  await composer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(composer).toBeHidden()

  await orcaPage.evaluate(
    ({ repoId, worktreeId }) => {
      const state = window.__store!.getState()
      state.setActiveRepo(repoId)
      state.setActiveWorktree(worktreeId)
    },
    { repoId: target.repoA, worktreeId: target.mainA }
  )
  await openSidebarWorkspaceComposer(orcaPage)
  await expect(composer).toBeVisible()
  await expect(runTarget).toContainText(checkoutA)
  await composer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(composer).toBeHidden()

  const name = 'explicit-checkout-b'
  const openProjectOnly = async (): Promise<void> => {
    await orcaPage.evaluate(
      ({ projectHint, name }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(null)
        state.setActiveRepo(null)
        state.openModal('new-workspace-composer', {
          initialWorkspaceTarget: projectHint,
          prefilledName: name
        })
      },
      { projectHint, name }
    )
    await expect(composer).toBeVisible()
    await composer.locator('[data-workspace-name-input="true"]').fill(name)
    await expect(create).toBeDisabled()
  }
  const chooseB = async (): Promise<void> => {
    await composer.getByRole('combobox', { name: 'Run on' }).click()
    await expect(orcaPage.getByRole('option').filter({ hasText: checkoutA })).toHaveCount(1)
    const rowB = orcaPage.getByRole('option').filter({ hasText: checkoutB })
    await expect(rowB).toHaveCount(1)
    await orcaPage.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('checkout-options.png')
    })
    await rowB.click()
    await expect(runTarget).toContainText(checkoutB)
    await expect(create).toBeEnabled()
  }

  await openProjectOnly()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('project-only-ambiguous.png')
  })
  await chooseB()
  await composer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(composer).toBeHidden()
  await openProjectOnly()
  await chooseB()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('checkout-b-selected.png')
  })
  await create.click()
  await expect(composer).toBeHidden({ timeout: 30_000 })

  await expect
    .poll(
      async () =>
        orcaPage.evaluate(
          ({ repoId, name }) => {
            const state = window.__store!.getState()
            return (
              state.worktreesByRepo[repoId]?.find((worktree) => worktree.displayName === name)
                ?.path ?? null
            )
          },
          { repoId: target.repoB, name }
        ),
      { timeout: 30_000 }
    )
    .not.toBeNull()
  const createdPath = await orcaPage.evaluate(
    ({ repoId, name }) => {
      const worktree = window
        .__store!.getState()
        .worktreesByRepo[repoId]?.find((worktree) => worktree.displayName === name)
      if (!worktree) {
        throw new Error('Chosen checkout did not contain the created workspace')
      }
      return worktree.path
    },
    { repoId: target.repoB, name }
  )
  expect(createdPath.startsWith(path.join(checkoutB, '.routing-workspaces') + path.sep)).toBe(true)
  const commonDir = path.resolve(createdPath, git(createdPath, ['rev-parse', '--git-common-dir']))
  expect(realpathSync(commonDir)).toBe(realpathSync(path.join(checkoutB, '.git')))
  expect(git(checkoutA, ['worktree', 'list', '--porcelain'])).not.toContain(createdPath)
  await expect(
    orcaPage.locator('[role="option"][aria-current="page"]').filter({ hasText: name })
  ).toBeVisible()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('checkout-b-created.png')
  })

  const folderParent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-routing-folder-')))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(folderParent, { recursive: true, force: true })
  )
  await orcaPage.evaluate(async (parentPath) => {
    const state = window.__store!.getState()
    const group = await window.api.projectGroups.create({
      name: 'Routing folder control',
      parentPath,
      createdFrom: 'folder-scan'
    })
    await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    window.__store!.getState().openModal('new-workspace-composer', {
      initialProjectGroupId: group.id,
      prefilledName: 'Folder routing control'
    })
  }, folderParent)
  const folderComposer = orcaPage.getByRole('dialog', { name: 'Create Folder Workspace' })
  await expect(folderComposer).toBeVisible()
  await folderComposer.locator('[data-workspace-name-input="true"]').fill('Folder routing control')
  const createFolder = folderComposer.getByRole('button', { name: /Create workspace/i })
  await expect(createFolder).toBeEnabled()
  await createFolder.click()
  await expect(folderComposer).toBeHidden()
  const folderPath = await orcaPage.evaluate(() => {
    const folder = window
      .__store!.getState()
      .folderWorkspaces.find((workspace) => workspace.name === 'Folder routing control')
    if (!folder) {
      throw new Error('Folder control did not create a folder workspace')
    }
    return folder.folderPath
  })
  expect(realpathSync(folderPath)).toBe(folderParent)
  expect(existsSync(folderPath)).toBe(true)
  expect(existsSync(path.join(folderPath, '.git'))).toBe(false)
  await expect(
    orcaPage
      .locator('[role="option"][aria-current="page"]')
      .filter({ hasText: 'Folder routing control' })
  ).toBeVisible()
  await orcaPage.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('folder-control-created.png')
  })

  const nativeState = await electronApp.evaluate(({ app, BrowserWindow }) => ({
    appPath: app.getAppPath(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(realpathSync(nativeState.appPath)).toBe(realpathSync(process.cwd()))
  expect(nativeState.windows.length).toBeGreaterThan(0)
  expect(nativeState.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  const nativeEvidencePath = testInfo.outputPath('native-hidden-state.json')
  writeFileSync(
    nativeEvidencePath,
    JSON.stringify(
      { ...nativeState, checkoutA, checkoutB, createdPath, commonDir, folderPath },
      null,
      2
    )
  )
  await testInfo.attach('native-hidden-state.json', {
    path: nativeEvidencePath,
    contentType: 'application/json'
  })
})
