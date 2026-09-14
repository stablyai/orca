import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { FILE_HANDLERS } from '../../src/cli/handlers/file'

test('file viewers float, update and restore independently of workspace focus', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const documentPath = path.join(testRepoPath, 'viewer-sample.md')
  const imagePath = path.join(testRepoPath, 'viewer-image.svg')
  writeFileSync(documentPath, '# Viewer sample\n\nRead-only document preview.\n')
  writeFileSync(
    imagePath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#2563eb"/><text x="40" y="130" fill="white" font-size="32">Viewer sample</text></svg>'
  )
  const session = createRestartSession(testInfo, { ELECTRON_RENDERER_URL: '' })
  let app: ElectronApplication | null = null
  try {
    let launched = await session.launch()
    app = launched.app
    let page = launched.page
    await waitForSessionReady(page)
    await page.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
    const primaryWorktree = await attachRepoAndOpenTerminal(page, testRepoPath)
    const client = new RuntimeClient(
      await app.evaluate(({ app }) => app.getPath('userData')),
      30_000,
      null,
      null
    )
    const openFromCli = (filePath: string) =>
      FILE_HANDLERS['file open']!({
        client,
        cwd: testRepoPath,
        json: true,
        flags: new Map([
          ['path', filePath],
          ['worktree', `id:${primaryWorktree}`]
        ])
      })
    await page.evaluate(
      async (folderPath) => {
        const group = await window.api.projectGroups.create({
          name: 'Viewer folder',
          parentPath: folderPath
        })
        await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          name: 'Viewer folder',
          folderPath
        })
        await window.__store!.getState().fetchProjectGroups()
        await window.__store!.getState().fetchFolderWorkspaces()
      },
      path.join(testRepoPath, 'src')
    )
    await page.locator('[data-workspace-multiplexer-trigger]').click()
    const header = page.locator('[data-workspace-multiplexer-page] > header')
    await header.getByRole('button', { name: 'Add workspace', exact: true }).click()
    await page
      .locator(`[data-workspace-multiplexer-worktree-id=${JSON.stringify(primaryWorktree)}]`)
      .click()
    const treeToggle = header.getByRole('button', { name: 'Toggle right sidebar', exact: true })
    if ((await treeToggle.getAttribute('aria-expanded')) === 'true') {
      await treeToggle.click()
    }
    await treeToggle.click()
    const tree = page.locator('[data-orca-explorer-shell]')
    await expect(tree).toBeVisible()
    await openFromCli('viewer-sample.md')
    const windows = page.locator('[data-floating-file-viewer]')
    await expect(windows).toHaveCount(1)
    await expect(windows.first().getByRole('heading', { name: 'Viewer sample' })).toBeVisible()
    await tree.getByText('viewer-image.svg', { exact: true }).click()
    await expect(windows).toHaveCount(2)
    const image = page.getByRole('region', { name: /^viewer-image.svg/ })
    await expect(image.getByRole('img', { name: 'viewer-image.svg', exact: true })).toBeVisible()
    await image.getByTitle('Zoom in', { exact: true }).click()
    await expect(image).toContainText('125%')
    const title = image.locator('[data-floating-file-viewer-titlebar]')
    const start = (await title.boundingBox())!
    await page.mouse.move(start.x + 40, start.y + 20)
    await page.mouse.down()
    await page.mouse.move(start.x + 140, start.y + 100, { steps: 8 })
    await page.mouse.up()
    const moved = (await image.boundingBox())!
    expect(moved.x).toBeGreaterThan(start.x + 50)
    await page.mouse.move(moved.x + moved.width - 6, moved.y + moved.height - 6)
    await page.mouse.down()
    await page.mouse.move(moved.x + moved.width + 48, moved.y + moved.height + 38, { steps: 8 })
    await page.mouse.up()
    const resized = (await image.boundingBox())!
    expect(resized.width).toBeGreaterThan(moved.width + 20)
    writeFileSync(documentPath, '# Updated document\n\nChanges appear automatically.\n')
    await expect(page.getByRole('heading', { name: 'Updated document' })).toBeVisible()
    await tree.getByText('viewer-sample.md', { exact: true }).click()
    await expect(windows).toHaveCount(2)
    const sourceWorktree = await tree.getAttribute('data-worktree-id')
    await header.getByRole('button', { name: 'Add workspace', exact: true }).click()
    const otherOption = page
      .locator(
        `[data-workspace-multiplexer-worktree-id]:not([data-workspace-multiplexer-worktree-id=${JSON.stringify(primaryWorktree)}])`
      )
      .first()
    const otherWorktree = await otherOption.getAttribute('data-workspace-multiplexer-worktree-id')
    await otherOption.click()
    await expect(tree).toHaveAttribute('data-worktree-id', otherWorktree!)
    await page.locator('[data-floating-file-viewers-toggle]').click()
    await expect(page.locator('[data-floating-file-viewer]:visible')).toHaveCount(0)
    await openFromCli('viewer-image.svg')
    await expect(tree).toHaveAttribute('data-worktree-id', otherWorktree!)
    await expect(page.locator('[data-workspace-multiplexer-page]')).toBeVisible()
    await expect(page.locator('[data-floating-file-viewer]:visible')).toHaveCount(2)
    for (const window of await windows.all()) {
      await expect(window).toHaveAttribute('data-worktree-id', sourceWorktree!)
    }
    const terminal = page.locator('[data-workspace-multiplexer-slot-id] .xterm:visible').first()
    await terminal.click({ position: { x: 10, y: 10 } })
    await expect(terminal.locator('textarea.xterm-helper-textarea')).toBeFocused()
    await expect(page.locator('[data-floating-file-viewer]:visible')).toHaveCount(2)
    await page.screenshot({ path: 'output/playwright/multiplexer-file-viewers.png' })
    await page.locator('[data-floating-file-viewers-toggle]').click()
    await expect(page.locator('[data-floating-file-viewer]:visible')).toHaveCount(0)
    await session.close(app)
    app = null
    launched = await session.launch()
    app = launched.app
    page = launched.page
    await waitForSessionReady(page)
    await expect(page.locator('[data-floating-file-viewers-toggle]')).toContainText(
      'Show viewers (2)'
    )
    await page.locator('[data-floating-file-viewers-toggle]').click()
    const restored = page.getByRole('region', { name: /^viewer-image.svg/ })
    await expect(restored).toBeVisible()
    expect((await restored.boundingBox())?.width).toBeCloseTo(resized.width, 0)
    await page.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
    await page.setViewportSize({ width: 1000, height: 720 })
    await expect(restored).toBeVisible()
    await page.screenshot({ path: 'output/playwright/multiplexer-file-viewers-dark.png' })
    await restored.getByRole('button', { name: 'Close viewer', exact: true }).click()
    await expect(page.locator('[data-floating-file-viewer]')).toHaveCount(1)
    unlinkSync(documentPath)
    await expect(page.getByText('Unable to load file', { exact: true })).toBeVisible()
    await page.locator('[data-floating-file-viewer-titlebar]').click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
    await expect(page.locator('[data-floating-file-viewer]')).toHaveCount(0)
    await expect(
      page.locator('[data-workspace-multiplexer-slot-id] .xterm:visible').first()
    ).toBeVisible()
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
