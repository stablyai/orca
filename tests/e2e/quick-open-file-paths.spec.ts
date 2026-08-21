import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/mcode-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const relativeFilePath =
  'packages/mcode/src/renderer/src/components/navigation/worktree/quick-open/long-path-fixtures/very-deeply-nested-folder/QuickOpenTarget.tsx'

test('cmd+p quick open prioritizes the filename and reveals the full path on hover', async ({
  electronApp,
  mcodePage,
  testRepoPath
}) => {
  const filePath = path.join(testRepoPath, ...relativeFilePath.split('/'))
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, 'export const QuickOpenTarget = true\n')

  await waitForSessionReady(mcodePage)
  await waitForActiveWorktree(mcodePage)
  await ensureTerminalVisible(mcodePage)

  // Headless Playwright keyboard events bypass Electron’s before-input-event shortcut path.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ui:openQuickOpen')
  })
  const dialog = mcodePage.getByRole('dialog', { name: 'Go to file' })
  await expect(dialog).toBeVisible()
  const inputBox = await dialog.locator('[data-cmdk-input-wrapper]').boundingBox()
  expect(inputBox).not.toBeNull()
  expect(inputBox!.height).toBeLessThanOrEqual(45)
  const input = dialog.locator('input[placeholder="Go to file..."]')
  await input.fill('QuickOpenTarget')

  const row = dialog.getByRole('option').filter({ hasText: 'QuickOpenTarget.tsx' }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('packages/mcode/src/renderer/src/components/navigation/')
  const rowBox = await row.boundingBox()
  expect(rowBox).not.toBeNull()
  expect(rowBox!.height).toBeLessThanOrEqual(29)
  const rowText = await row.textContent()
  expect(rowText?.indexOf('QuickOpenTarget.tsx')).toBeLessThan(
    rowText?.indexOf('packages/mcode/src/renderer/src/components/navigation/') ?? -1
  )

  // Two hovers on purpose: results stream in and remount the row, and Radix only
  // opens on a pointermove it actually receives. A single hover can land before
  // the remount and leave the cursor sitting still over a row that never saw it.
  await row.hover({ position: { x: 20, y: 12 } })
  await mcodePage.waitForTimeout(250)
  await row.hover({ position: { x: 40, y: 12 } })

  // Exact cursor placement is arithmetic, unit-tested via cursorTooltipOffsets.
  // Asserting it here measures the app mid-reflow and is flaky; what E2E is
  // uniquely good for is that the tooltip really opens with the whole path.
  await expect(
    mcodePage.locator('[data-slot="tooltip-content"]').filter({ hasText: relativeFilePath })
  ).toBeVisible()

  const proofPath = process.env.MCODE_QUICK_OPEN_PROOF_PATH
  if (proofPath) {
    await mcodePage.screenshot({ path: proofPath })
  }
})
