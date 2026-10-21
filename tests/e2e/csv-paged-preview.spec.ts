import { closeSync, openSync, readFileSync, statSync, writeSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test.use({
  orcaAppExtraArgs: [
    '--enable-precise-memory-info',
    ...(process.env.ORCA_CSV_CDP_PORT
      ? [`--remote-debugging-port=${process.env.ORCA_CSV_CDP_PORT}`]
      : [])
  ]
})

test('CSV preview bounds memory and DOM size, resizes columns and reaches the final row', async ({
  orcaPage,
  seededRepoPath,
  electronApp
}, testInfo) => {
  test.setTimeout(120_000)
  const totalRows = 1_900_100
  const tallName = 'large-preview.csv'
  const wideName = 'wide-preview.csv'
  const tallPath = path.join(seededRepoPath, tallName)
  const widePath = path.join(seededRepoPath, wideName)
  const handle = openSync(tallPath, 'w')
  try {
    writeSync(handle, 'id,label,a,b,c,d,e,f\n')
    for (let first = 0; first < totalRows; first += 16_384) {
      const count = Math.min(16_384, totalRows - first)
      writeSync(
        handle,
        Array.from(
          { length: count },
          (_, offset) =>
            `${String(first + offset).padStart(7, '0')},record-${first + offset},xxxxxxxxxxxx,alpha,beta,gamma,delta,omega\n`
        ).join('')
      )
    }
  } finally {
    closeSync(handle)
  }
  const wideHeader = Array.from({ length: 2048 }, (_, index) => `column-${index}`).join(';')
  const wideRow = Array.from({ length: 2048 }, (_, index) => `value-${index}`).join(';')
  writeFileSync(widePath, `${wideHeader}\n${`${wideRow}\n`.repeat(100)}`)
  const openFile = async (name: string): Promise<void> => {
    await orcaPage.evaluate(
      ({ name, filePath }) => {
        const state = window.__store?.getState()
        if (!state?.activeWorktreeId) {
          throw new Error('Missing CSV fixture worktree')
        }
        state.openFile({
          filePath,
          relativePath: name,
          worktreeId: state.activeWorktreeId,
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { name, filePath: path.join(seededRepoPath, name) }
    )
  }
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const sampleHeap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage')
    return (await cdp.send('Runtime.getHeapUsage')).usedSize
  }
  const baseline = await sampleHeap()
  const start = Date.now()
  await openFile(tallName)
  const table = orcaPage.getByRole('table')
  await expect(table).toHaveAttribute('aria-rowcount', String(totalRows + 1), { timeout: 60_000 })
  await expect(orcaPage.getByText('Large file preview · Read-only')).toBeVisible()
  await expect(orcaPage.getByRole('cell', { name: '0000000', exact: true })).toBeVisible()
  const indexMs = Date.now() - start
  for (let window = 0; window < 3; window += 1) {
    await orcaPage.getByRole('button', { name: 'Next rows' }).click()
  }
  await orcaPage.getByTestId('csv-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(
    orcaPage.getByRole('cell', { name: String(totalRows - 1), exact: true })
  ).toBeVisible()
  expect(await table.getByRole('row').count()).toBeLessThan(100)
  const retained = await sampleHeap()
  expect(retained - baseline).toBeLessThan(70 * 1024 * 1024)
  const sizeBefore = statSync(tallPath).size
  const saveBlocked = await orcaPage.evaluate(async () => {
    const file = window.__store
      ?.getState()
      .openFiles.find((candidate) => candidate.filePath.endsWith('large-preview.csv'))
    if (!file?.csvPreviewOnly) {
      throw new Error('CSV save guard was not installed')
    }
    return new Promise<boolean>((resolve) =>
      window.dispatchEvent(
        new CustomEvent('orca:editor-save-file', {
          detail: {
            fileId: file.id,
            fallbackContent: '',
            claim: () => {},
            resolve: () => resolve(false),
            reject: () => resolve(true)
          }
        })
      )
    )
  })
  expect(saveBlocked).toBe(true)
  expect(statSync(tallPath).size).toBe(sizeBefore)
  await orcaPage.screenshot({ path: testInfo.outputPath('large-final-row.png') })

  await openFile(wideName)
  await expect(orcaPage.getByRole('table')).toHaveAttribute('aria-colcount', '2049')
  await expect(orcaPage.getByRole('cell', { name: 'value-0', exact: true }).first()).toBeVisible()
  expect(await table.getByRole('columnheader').count()).toBeLessThan(30)
  expect(await table.getByRole('cell').count()).toBeLessThan(2000)
  const separator = orcaPage.getByRole('separator', { name: 'Resize column 1', exact: true })
  const width = Number(await separator.getAttribute('aria-valuenow'))
  await separator.dispatchEvent('keydown', { key: 'ArrowRight', shiftKey: true })
  await expect(separator).toHaveAttribute('aria-valuenow', String(width + 40))
  const handleBox = await separator.boundingBox()
  if (!handleBox) {
    throw new Error('Missing resize handle')
  }
  await separator.dispatchEvent('pointerdown', { pointerId: 1, button: 0, clientX: handleBox.x })
  await separator.dispatchEvent('pointermove', { pointerId: 1, clientX: handleBox.x + 60 })
  await separator.dispatchEvent('pointerup', { pointerId: 1, clientX: handleBox.x + 60 })
  await expect(separator).toHaveAttribute('aria-valuenow', String(width + 100))
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const file = state?.openFiles.find((file) => file.filePath.endsWith('wide-preview.csv'))
    if (!state || !file) {
      throw new Error('Missing wide preview tab')
    }
    state.closeFile(file.id)
  })
  await openFile(wideName)
  await expect(separator).toHaveAttribute('aria-valuenow', String(width + 100))
  await expect(orcaPage.getByRole('button', { name: 'Edit cell', exact: true })).toHaveCount(0)
  await orcaPage.getByTestId('csv-scroll').evaluate((element) => {
    element.scrollLeft = element.scrollWidth
  })
  await expect(
    orcaPage.getByRole('cell', { name: 'value-2047', exact: true }).first()
  ).toBeVisible()
  expect(await table.getByRole('columnheader').count()).toBeLessThan(30)
  await orcaPage.screenshot({ path: testInfo.outputPath('wide-final-column.png') })
  if (
    process.env.ORCA_E2E_FORCE_HEADFUL !== '1' &&
    testInfo.project.metadata.orcaHeadful !== true
  ) {
    const windowsVisible = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
    expect(windowsVisible).toBe(false)
  }
  const observations = {
    bytes: sizeBefore,
    rows: totalRows,
    indexMs,
    rendererHeapDeltaMiB: (retained - baseline) / 1024 / 1024,
    renderedRows: await table.getByRole('row').count(),
    renderedColumns: await table.getByRole('columnheader').count(),
    wideBytes: readFileSync(widePath).length
  }
  writeFileSync(testInfo.outputPath('csv-measurements.json'), JSON.stringify(observations, null, 2))
})

test('paged previews accept a maximum-size record with a BOM and CRLF', async ({
  orcaPage,
  seededRepoPath,
  electronApp
}, testInfo) => {
  const name = 'record-boundary.csv'
  const filePath = path.join(seededRepoPath, name)
  const recordBytes = 1024 * 1024
  writeFileSync(filePath, `\ufeff${'x'.repeat(recordBytes)}\r\ntail\r\n`)
  await orcaPage.evaluate(
    ({ name, filePath }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('Missing CSV boundary workspace')
      }
      state.openFile({
        filePath,
        relativePath: name,
        worktreeId: state.activeWorktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
    },
    { name, filePath }
  )
  await expect(orcaPage.getByRole('table')).toHaveAttribute('aria-rowcount', '2', {
    timeout: 30_000
  })
  await expect(orcaPage.getByRole('cell', { name: 'tail', exact: true })).toBeVisible()
  expect(
    await orcaPage
      .getByRole('columnheader')
      .nth(1)
      .evaluate((element) => element.textContent?.length)
  ).toBe(recordBytes)
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
