import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const relativeFilePath =
  'packages/orca/src/renderer/src/components/navigation/worktree/quick-open/long-path-fixtures/very-deeply-nested-folder/QuickOpenTarget.tsx'

test('cmd+p quick open prioritizes the filename and reveals the full path on hover', async ({
  electronApp,
  orcaPage,
  testRepoPath
}) => {
  const filePath = path.join(testRepoPath, ...relativeFilePath.split('/'))
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, 'export const QuickOpenTarget = true\n')

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  // Headless Playwright keyboard events bypass Electron’s before-input-event shortcut path.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ui:openQuickOpen')
  })
  const dialog = orcaPage.getByRole('dialog', { name: 'Go to file' })
  await expect(dialog).toBeVisible()
  const input = dialog.locator('input[placeholder="Go to file..."]')
  await input.fill('QuickOpenTarget')

  const row = dialog.getByRole('option').filter({ hasText: 'QuickOpenTarget.tsx' }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('packages/orca/src/renderer/src/components/navigation/')
  const rowText = await row.textContent()
  expect(rowText?.indexOf('QuickOpenTarget.tsx')).toBeLessThan(
    rowText?.indexOf('packages/orca/src/renderer/src/components/navigation/') ?? -1
  )

  // Two hovers on purpose: results stream in and remount the row, and Radix only
  // opens on a pointermove it actually receives. A single hover can land before
  // the remount and leave the cursor sitting still over a row that never saw it.
  await row.hover({ position: { x: 20, y: 12 } })
  await orcaPage.waitForTimeout(250)
  await row.hover({ position: { x: 40, y: 12 } })

  // Exact cursor placement is arithmetic, unit-tested via cursorTooltipOffsets.
  // Asserting it here measures the app mid-reflow and is flaky; what E2E is
  // uniquely good for is that the tooltip really opens with the whole path.
  await expect(
    orcaPage.locator('[data-slot="tooltip-content"]').filter({ hasText: relativeFilePath })
  ).toBeVisible()

  const proofPath = process.env.ORCA_QUICK_OPEN_PROOF_PATH
  if (proofPath) {
    await orcaPage.screenshot({ path: proofPath })
  }
})
