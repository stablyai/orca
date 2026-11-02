import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

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

test('CSV links navigate from small and paged previews without replacing the renderer', async ({
  orcaPage,
  seededRepoPath,
  electronApp
}, testInfo) => {
  test.setTimeout(90_000)
  const url = 'https://example.com/?from=csv#demo'
  const smallName = 'csv-links.csv'
  const largeName = 'csv-links-large.csv'
  const content = `name,url,notes\nExample,${url},javascript:alert(1)\n`
  writeFileSync(path.join(seededRepoPath, smallName), content)
  writeFileSync(
    path.join(seededRepoPath, largeName),
    content + `Record,${url},${'x'.repeat(200)}\n`.repeat(6000)
  )
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ openLinksInApp: true })
  })
  for (const name of [smallName, largeName]) {
    await orcaPage.evaluate(
      ({ name, filePath }) => {
        const state = window.__store?.getState()
        if (!state?.activeWorktreeId) {
          throw new Error('Missing CSV test workspace')
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
      { name, filePath: path.join(seededRepoPath, name) }
    )
    const link = orcaPage.getByTestId('csv-grid').getByRole('link', { name: url }).first()
    await expect(link).toBeVisible({ timeout: 30_000 })
    await expect(link).toHaveAttribute('href', url)
    await expect(
      orcaPage
        .getByTestId('csv-grid')
        .locator('[data-csv-column="2"]')
        .filter({ hasText: 'javascript:alert(1)' })
        .first()
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath(`${name}.png`) })
    const rendererUrl = orcaPage.url()
    const tabsBefore = await orcaPage.evaluate(
      () => Object.values(window.__store?.getState().browserTabsByWorktree ?? {}).flat().length
    )
    if (name === largeName) {
      await link.focus()
      await orcaPage.keyboard.press('Enter')
    } else {
      await link.click()
    }
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => Object.values(window.__store?.getState().browserTabsByWorktree ?? {}).flat().length
        )
      )
      .toBe(tabsBefore + 1)
    expect(
      await orcaPage.evaluate(
        () =>
          Object.values(window.__store?.getState().browserTabsByWorktree ?? {})
            .flat()
            .at(-1)?.url
      )
    ).toBe(url)
    expect(orcaPage.url()).toBe(rendererUrl)
  }
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
