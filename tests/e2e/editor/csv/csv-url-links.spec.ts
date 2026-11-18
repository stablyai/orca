import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'

test('dense CSVs below 1 MiB remain visible and shrinking a later row window recovers', async ({
  orcaPage,
  seededRepoPath,
  electronApp
}, testInfo) => {
  const name = 'dense-small.csv'
  const filePath = path.join(seededRepoPath, name)
  writeFileSync(filePath, `id\n${'\n'.repeat(600_000)}`)
  await orcaPage.evaluate(
    ({ name, filePath }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('Missing dense CSV workspace')
      }
      state.openFile(
        {
          filePath,
          relativePath: name,
          worktreeId: state.activeWorktreeId,
          language: 'plaintext',
          mode: 'edit'
        },
        { preview: false }
      )
    },
    { name, filePath }
  )
  await expect(orcaPage.getByTestId('csv-grid')).toHaveAttribute('aria-rowcount', '600001')
  await orcaPage.getByRole('button', { name: 'Next rows' }).click()
  await expect(orcaPage.getByRole('rowheader', { name: '500001', exact: true })).toBeVisible()
  await orcaPage.getByTestId('csv-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(orcaPage.getByRole('rowheader', { name: '600000', exact: true })).toBeVisible()
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const file = state?.openFiles.find((file) => file.filePath.endsWith('dense-small.csv'))
    if (!state || !file) {
      throw new Error('Missing dense CSV tab')
    }
    state.setEditorDraft(file.id, 'id\nfirst\nsecond\nthird\n')
  })
  await expect(orcaPage.getByTestId('csv-grid')).toHaveAttribute('aria-rowcount', '4')
  await expect(orcaPage.getByRole('gridcell', { name: 'first', exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('gridcell', { name: 'third', exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Next rows' })).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('dense-after-shrink.png') })
  if (
    process.env.ORCA_E2E_FORCE_HEADFUL !== '1' &&
    testInfo.project.metadata.orcaHeadful !== true
  ) {
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  }
})
