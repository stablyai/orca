import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('Project home saves context and preserves a draft when another client edits it', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.screenshot({
    path: testInfo.outputPath('before-project-home.png'),
    fullPage: true
  })
  const initialTabs = await orcaPage.evaluate(() =>
    Object.values(window.__store!.getState().tabsByWorktree)
      .flat()
      .map((tab) => tab.id)
  )
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const repo = state.repos[0]
    if (!repo) {
      throw new Error('Seed repository missing')
    }
    state.openProjectHome(repo)
  })
  await expect(orcaPage.getByRole('heading', { name: 'Project context' })).toBeVisible()
  expect(
    await orcaPage.evaluate(() =>
      Object.values(window.__store!.getState().tabsByWorktree)
        .flat()
        .map((tab) => tab.id)
    )
  ).toEqual(initialTabs)
  const goal = orcaPage.getByLabel('Goal', { exact: true })
  const instructions = orcaPage.getByLabel('Instructions', { exact: true })
  await goal.fill('Ship the project home')
  await instructions.fill('Run tests before marking work complete.')
  await orcaPage.getByRole('button', { name: 'Save context', exact: true }).click()
  await expect(orcaPage.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await orcaPage.getByText('Preview coordinator draft', { exact: true }).click()
  await expect(
    orcaPage.getByText('Coordinate this project using Orca', { exact: false })
  ).toContainText('Ship the project home')
  await expect(orcaPage.getByRole('heading', { name: 'Run history' })).not.toBeVisible()
  await goal.fill('My unsaved draft')
  await orcaPage.evaluate(async () => {
    const repo = window.__store!.getState().projectHomeRepo!
    const project = (await window.api.projects.list()).find((entry) =>
      entry.sourceRepoIds.includes(repo.id)
    )!
    await window.api.projects.update({
      projectId: project.id,
      updates: {
        coordination: {
          goal: 'Other client goal',
          instructions: 'Other instructions',
          expectedRevision: project.coordination?.revision ?? 0
        }
      }
    })
  })
  await orcaPage.getByRole('button', { name: 'Save context', exact: true }).click()
  await expect(orcaPage.getByRole('alert')).toContainText('changed')
  await expect(goal).toHaveValue('My unsaved draft')
  await orcaPage.getByRole('button', { name: 'Load latest saved context' }).click()
  await expect(
    orcaPage.getByRole('status').filter({ hasText: 'Your draft is preserved' })
  ).toBeVisible()
  await expect(orcaPage.getByText('Other client goal', { exact: false }).first()).toBeVisible()
  await expect(goal).toHaveValue('My unsaved draft')
  await orcaPage.screenshot({ path: testInfo.outputPath('project-home.png'), fullPage: true })
  await orcaPage.getByRole('button', { name: 'Back to workspace' }).click()
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openProjectHome(state.projectHomeRepo!)
  })
  await expect(orcaPage.getByLabel('Goal', { exact: true })).toHaveValue('My unsaved draft')
  await orcaPage.getByRole('button', { name: 'Discard draft', exact: true }).click()
  await expect(orcaPage.getByLabel('Goal', { exact: true })).toHaveValue('Other client goal')
  await orcaPage.evaluate(async () => {
    const repo = window.__store!.getState().projectHomeRepo!
    const project = (await window.api.projects.list()).find((entry) =>
      entry.sourceRepoIds.includes(repo.id)
    )!
    await window.api.projects.update({
      projectId: project.id,
      updates: {
        coordination: {
          goal: 'Newest saved goal',
          instructions: 'Fresh instructions',
          expectedRevision: project.coordination?.revision ?? 0
        }
      }
    })
  })
  await orcaPage.getByRole('button', { name: 'Load latest saved context' }).click()
  await expect(orcaPage.getByLabel('Goal', { exact: true })).toHaveValue('Newest saved goal')
  await expect(orcaPage.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Fresh instructions'
  )
  await expect(
    orcaPage.getByRole('button', { name: 'Discard draft', exact: true })
  ).not.toBeVisible()
})

test('Project home offers a non-git folder workspace without launching an agent', async ({
  orcaPage
}, testInfo) => {
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-project-home-')))
  try {
    await waitForSessionReady(orcaPage)
    const folder = await orcaPage.evaluate(async (directory) => {
      const state = window.__store!.getState()
      const repo = await state.addNonGitFolder(directory)
      if (!repo) {
        throw new Error('Folder project missing')
      }
      const current = window.__store!.getState()
      const workspace = current.worktreesByRepo[repo.id]?.[0]
      if (!workspace) {
        throw new Error('Folder workspace missing')
      }
      return {
        repoId: repo.id,
        workspaceId: workspace.id,
        label: workspace.branch || workspace.path
      }
    }, folderPath)
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
          folder.workspaceId
        )
      )
      .toBeGreaterThan(0)
    const initialTabs = await orcaPage.evaluate((id) => {
      const state = window.__store!.getState()
      const repo = state.repos.find((entry) => entry.id === id)
      if (!repo) {
        throw new Error('Folder project disappeared')
      }
      const tabs = Object.values(state.tabsByWorktree)
        .flat()
        .map((tab) => tab.id)
      state.openProjectHome(repo)
      return tabs
    }, folder.repoId)
    await expect(orcaPage.getByRole('heading', { name: 'Project context' })).toBeVisible()
    await expect(orcaPage.getByRole('combobox', { name: 'Workspace', exact: true })).toContainText(
      folder.label
    )
    await orcaPage.getByLabel('Goal', { exact: true }).fill('Inspect this folder')
    await orcaPage.getByRole('button', { name: 'Save context', exact: true }).click()
    await expect(orcaPage.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    await orcaPage.getByText('Preview coordinator draft', { exact: true }).click()
    await expect(
      orcaPage.getByText('Coordinate this project using Orca', { exact: false })
    ).toContainText('Inspect this folder')
    expect(
      await orcaPage.evaluate(() =>
        Object.values(window.__store!.getState().tabsByWorktree)
          .flat()
          .map((tab) => tab.id)
      )
    ).toEqual(initialTabs)
    await orcaPage.screenshot({
      path: testInfo.outputPath('project-home-folder.png'),
      fullPage: true
    })
  } finally {
    rmSync(folderPath, { recursive: true, force: true })
  }
})
