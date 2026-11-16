import { expectSidebarProjectVisible } from './helpers/sidebar-project-visibility'
import { openSidebarProjectMenu } from './helpers/sidebar-project-dialog'
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { ProjectGroup } from '../../src/shared/project/groups/project-group-types'
import type { Repo } from '../../src/shared/repository/repo-types'
import { expect, test } from './helpers/orca-app'
import { forwardRendererConsole } from './helpers/renderer-console-forwarding'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'
import {
  configureIsolatedGitIdentity,
  createProjectFixtures
} from './pr11346-selected-runtime-identity-oracle'

async function selectRuntimeHost(page: Page, runtimeName: string): Promise<Locator> {
  await openSidebarProjectMenu(page)
  const menu = page.getByRole('menu', { name: 'Add project' })
  const hostPicker = menu.getByRole('menuitem', { name: /Project host:/i })
  if (!(await hostPicker.textContent())?.includes(runtimeName)) {
    await hostPicker.hover()
    await page.getByRole('menuitem').filter({ hasText: runtimeName }).click()
  }
  await expect(hostPicker).toContainText(runtimeName)
  return menu
}

async function selectRuntimeHostAndOpenManualPath(
  page: Page,
  runtimeName: string
): Promise<Locator> {
  const menu = await selectRuntimeHost(page, runtimeName)
  await menu.getByRole('menuitem', { name: /Browse folder/i }).click()
  const browseDialog = page.getByRole('dialog', { name: /Browse host filesystem/i })
  await expect(browseDialog).toBeVisible()
  await browseDialog.getByRole('button', { name: /^Cancel$/i }).click()
  const manualDialog = page.getByRole('dialog', { name: /Open host project/i })
  await expect(manualDialog.locator('#server-project-path')).toBeVisible()
  return manualDialog
}

async function listRuntimeInventory(client: RuntimeClient): Promise<{
  projectGroups: ProjectGroup[]
  repos: Repo[]
}> {
  const [repoResult, projectGroupResult] = await Promise.all([
    client.call<{ repos: Repo[] }>('repo.list'),
    client.call<{ groups: ProjectGroup[] }>('projectGroup.list')
  ])
  return {
    repos: repoResult.result.repos,
    projectGroups: projectGroupResult.result.groups
  }
}

async function runSelectedRuntimeAddJourney(
  electronApp: ElectronApplication,
  orcaPage: Page,
  testInfo: TestInfo
): Promise<void> {
  const runtimeName = 'PR 11346 hidden-window runtime'
  const fixture = await createProjectFixtures()
  await waitForSessionReady(orcaPage)
  configureIsolatedGitIdentity(await electronApp.evaluate(({ app }) => app.getPath('home')))

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, runtimeName)
  // Forward renderer console because contained render failures expose their component stacks only there.
  forwardRendererConsole(client.page, testInfo)
  const serverUserDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const clientUserDataDir = await client.app.evaluate(({ app }) => app.getPath('userData'))
  const serverRuntime = new RuntimeClient(serverUserDataDir)
  const clientLocalRuntime = new RuntimeClient(clientUserDataDir)

  try {
    const gitDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await gitDialog.locator('#server-project-path').fill(fixture.gitPath)
    await gitDialog.getByRole('button', { name: /Add Git Project/i }).click()
    await expect(gitDialog).toBeHidden({ timeout: 30_000 })
    const folderDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await folderDialog.locator('#server-project-path').fill(fixture.folderPath)
    await folderDialog.getByRole('button', { name: /Open as Folder/i }).click()
    await expect(folderDialog).toBeHidden({ timeout: 30_000 })

    const cloneMenu = await selectRuntimeHost(client.page, runtimeName)
    await cloneMenu.getByRole('menuitem', { name: /Clone from URL/i }).click()
    const cloneStep = client.page.getByRole('dialog', { name: /Clone from URL/i })
    await cloneStep.getByRole('textbox').nth(0).fill(fixture.gitPath)
    await cloneStep.getByRole('textbox').nth(1).fill(fixture.cloneParentPath)
    await cloneStep.getByRole('button', { name: /^Clone$/i }).click()
    await expect(cloneStep).toBeHidden({ timeout: 30_000 })

    const createMenu = await selectRuntimeHost(client.page, runtimeName)
    await createMenu.getByRole('menuitem', { name: /Create new project/i }).click()
    const createStep = client.page.getByRole('dialog', { name: /Create a new project/i })
    await createStep.locator('#create-project-name').fill('runtime-created-project')
    await createStep.getByPlaceholder('/home/user/projects').fill(fixture.createParentPath)
    await createStep.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(createStep).toBeHidden({ timeout: 30_000 })

    const nestedDialog = await selectRuntimeHostAndOpenManualPath(client.page, runtimeName)
    await nestedDialog.locator('#server-project-path').fill(fixture.nestedParentPath)
    await nestedDialog.getByRole('button', { name: /Add Git Project/i }).click()
    const importDialog = client.page.getByRole('dialog', {
      name: /Import repositories from folder/i
    })
    await expect(importDialog.getByText('nested-api', { exact: true }).first()).toBeVisible({
      timeout: 30_000
    })
    await expect(importDialog.getByText('nested-web', { exact: true }).first()).toBeVisible()
    await importDialog.getByRole('button', { name: 'Yes, import as group', exact: true }).click()
    await expect(importDialog).toBeHidden({ timeout: 30_000 })

    await expect
      .poll(async () => {
        const inventory = await listRuntimeInventory(serverRuntime)
        return {
          groupParentPaths: inventory.projectGroups.map((group) => group.parentPath),
          repoPaths: inventory.repos.map((repo) => repo.path)
        }
      })
      .toEqual({
        groupParentPaths: expect.arrayContaining([fixture.nestedParentPath]),
        repoPaths: expect.arrayContaining([
          fixture.gitPath,
          fixture.folderPath,
          fixture.clonedRepoPath,
          fixture.createdRepoPath,
          ...fixture.nestedRepoPaths
        ])
      })

    const finalClientInventory = await listRuntimeInventory(clientLocalRuntime)
    for (const projectPath of [
      fixture.gitPath,
      fixture.folderPath,
      fixture.clonedRepoPath,
      fixture.createdRepoPath,
      ...fixture.nestedRepoPaths
    ]) {
      expect(finalClientInventory.repos.map((repo) => repo.path)).not.toContain(projectPath)
    }
    expect(finalClientInventory.projectGroups.map((group) => group.parentPath)).not.toContain(
      fixture.nestedParentPath
    )
    for (const projectName of [
      path.basename(fixture.gitPath),
      path.basename(fixture.folderPath),
      path.basename(fixture.clonedRepoPath),
      path.basename(fixture.createdRepoPath),
      ...fixture.nestedRepoPaths.map((repoPath) => path.basename(repoPath))
    ]) {
      // Why: duplicate checkout names are disambiguated with a parent path.
      await expectSidebarProjectVisible(client.page, projectName)
    }
    await client.page.screenshot({
      path: testInfo.outputPath('hidden-window-selected-runtime-add.png'),
      fullPage: true
    })
  } finally {
    await client.dispose()
    rmSync(fixture.rootPath, { recursive: true, force: true })
  }
}

test('adds selected-runtime projects through Browse, Clone, Create, and nested import', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  await runSelectedRuntimeAddJourney(electronApp, orcaPage, testInfo)
})
