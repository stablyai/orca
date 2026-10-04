import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('cycles visible folder workspaces with shortcuts and focused list arrows', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-folder-navigation-')))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(folderPath, { recursive: true, force: true })
  )

  const ids = await orcaPage.evaluate(async (parentPath) => {
    const store = window.__store!
    const group = await window.api.projectGroups.create({
      name: 'Folder project',
      parentPath,
      createdFrom: 'folder-scan'
    })
    await store.getState().fetchProjectGroups()
    const folder = await store.getState().createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Folder workspace',
      folderPath: parentPath
    })
    const repo = store.getState().repos[0]
    const [first, last] = repo ? (store.getState().worktreesByRepo[repo.id] ?? []) : []
    if (!folder || !repo || !first || !last) {
      throw new Error('Expected two git worktrees and one folder workspace')
    }
    await store.getState().updateFolderWorkspace(folder.id, { workspaceStatus: 'in-progress' })
    store.getState().setGroupBy('workspace-status')
    store.setState({
      collapsedGroups: new Set(),
      worktreesByRepo: {
        [repo.id]: [
          { ...first, hostId: 'local', displayName: 'Git workspace A', workspaceStatus: 'todo' },
          { ...last, hostId: 'local', displayName: 'Git workspace B', workspaceStatus: 'completed' }
        ]
      }
    })
    return [first.id, `folder:${folder.id}`, last.id]
  }, folderPath)

  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  const sidebar = orcaPage.locator('[data-worktree-sidebar]')
  const row = (id: string) =>
    sidebar.locator(`[role="option"][data-worktree-id=${JSON.stringify(id)}]`)
  await expect(sidebar.locator('[role="option"]')).toHaveCount(3)
  await expect
    .poll(() =>
      sidebar
        .locator('[role="option"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-worktree-id')))
    )
    .toEqual(ids)
  const [first, folder, last] = ids
  if (!first || !folder || !last) {
    throw new Error('Missing navigation targets')
  }
  const mod = await orcaPage.evaluate(() =>
    navigator.userAgent.includes('Mac') ? 'Meta' : 'Control'
  )
  const transitions = [
    { from: first, key: 'ArrowDown', to: folder },
    { from: last, key: 'ArrowUp', to: folder },
    { from: folder, key: 'ArrowDown', to: last },
    { from: folder, key: 'ArrowUp', to: first },
    { from: last, key: 'ArrowDown', to: first },
    { from: first, key: 'ArrowUp', to: last }
  ]
  const observed: { mode: string; from: string; key: string; to: string; current: string[] }[] = []

  // Clicking each starting row proves the folder already activates before keyboard cycling.
  for (const mode of ['shortcut', 'focused-list']) {
    for (const { from, key, to } of transitions) {
      await row(from).click()
      await expect(row(from)).toHaveAttribute('aria-current', 'page')
      if (mode === 'focused-list') {
        await orcaPage.keyboard.press(`${mod}+Shift+0`)
        await expect(sidebar).toBeFocused()
      }
      await orcaPage.keyboard.press(mode === 'shortcut' ? `${mod}+Shift+${key}` : key)
      await expect.soft(row(to)).toHaveAttribute('aria-current', 'page', { timeout: 3000 })
      observed.push({
        mode,
        from,
        key,
        to,
        current: await sidebar
          .locator('[aria-current="page"]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-worktree-id') ?? ''))
      })
      if (mode === 'focused-list') {
        await expect.soft(sidebar).toBeFocused()
      }
      if (to === folder) {
        const proofPath = testInfo.outputPath(`${mode}-${key}.png`)
        await sidebar.screenshot({ path: proofPath })
        await testInfo.attach(`${mode}-${key}`, { path: proofPath, contentType: 'image/png' })
      }
    }
  }
  await testInfo.attach('navigation-transitions', {
    body: JSON.stringify(observed, null, 2),
    contentType: 'application/json'
  })

  const folderSection = sidebar.getByRole('button', { name: /^In progress/ })
  await folderSection.click()
  await expect(row(folder)).toHaveCount(0)
  await row(first).click()
  await orcaPage.keyboard.press(`${mod}+Shift+ArrowDown`)
  await expect(row(last)).toHaveAttribute('aria-current', 'page')
  await folderSection.click()
  await expect(row(folder)).toHaveCount(1)

  await row(first).click()
  await orcaPage.setViewportSize({ width: 1000, height: 400 })
  await expect.poll(() => sidebar.evaluate((element) => element.clientHeight)).toBeGreaterThan(50)
  await sidebar.evaluate((element) => {
    element.scrollTop = 0
  })
  await orcaPage.keyboard.press(`${mod}+Shift+ArrowDown`)
  await expect(row(folder)).toHaveAttribute('aria-current', 'page')
  await expect(row(folder)).toBeInViewport({ ratio: 1 })
  await expect.poll(() => sidebar.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})
