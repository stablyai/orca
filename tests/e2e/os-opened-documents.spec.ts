import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'

for (const extension of ['md', 'csv', 'tsv'] as const) {
  test(`opens OS-requested ${extension} documents on cold and warm launches without duplicate tabs`, async ({
    seedTestRepo
  }, testInfo) => {
    void seedTestRepo
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-os-documents-')))
    const delimiter = extension === 'tsv' ? '\t' : ','
    const coldPath = path.join(root, `cold.${extension}`)
    const warmPath = path.join(root, `warm.${extension}`)
    writeFileSync(
      coldPath,
      extension === 'md'
        ? '# Cold result\n\n42\n'
        : `name${delimiter}amount\nCold result${delimiter}42\n`
    )
    writeFileSync(
      warmPath,
      extension === 'md'
        ? '# Warm result\n\n84\n'
        : `name${delimiter}amount\nWarm result${delimiter}84\n`
    )
    const unsupportedPath = path.join(root, 'unsupported.txt')
    writeFileSync(unsupportedPath, 'private content')
    const session = createRestartSession(testInfo, {
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1'
    })
    let launched: Awaited<ReturnType<typeof session.launch>> | undefined
    try {
      launched = await session.launch({ extraArgs: [coldPath, pathToFileURL(coldPath).href] })
      const { app, page } = launched
      const table = page.getByRole('table')
      const coldResult =
        extension === 'md'
          ? page.getByRole('heading', { name: 'Cold result' })
          : table.getByRole('cell', { name: 'Cold result', exact: true })
      const warmResult =
        extension === 'md'
          ? page.getByRole('heading', { name: 'Warm result' })
          : table.getByRole('cell', { name: 'Warm result', exact: true })
      await expect(coldResult).toBeVisible()
      await expect(page.getByText('42', { exact: true })).toBeVisible()
      await expect(
        page.locator('[data-tab-id]').filter({ hasText: `cold.${extension}` })
      ).toHaveCount(1)
      const coldProof = testInfo.outputPath('cold-open.png')
      await page.screenshot({ path: coldProof })
      await testInfo.attach('cold-open', { path: coldProof, contentType: 'image/png' })

      await app.evaluate(({ app }, fileUrl) => {
        app.emit('second-instance', {}, ['orca', fileUrl], process.cwd())
      }, pathToFileURL(warmPath).href)
      await expect(warmResult).toBeVisible()
      await expect(page.getByText('84', { exact: true })).toBeVisible()

      await page
        .locator('[data-tab-id]')
        .filter({ hasText: `cold.${extension}` })
        .click()
      await expect(coldResult).toBeVisible()

      await app.evaluate(({ app }, filePath) => {
        app.emit('open-file', { preventDefault() {} }, filePath)
      }, warmPath)
      await expect(warmResult).toBeVisible()
      await expect(
        page.locator('[data-tab-id]').filter({ hasText: `warm.${extension}` })
      ).toHaveCount(1)
      const warmProof = testInfo.outputPath('warm-open.png')
      await page.screenshot({ path: warmProof })
      await testInfo.attach('warm-open', { path: warmProof, contentType: 'image/png' })

      await app.evaluate(({ app }, filePath) => {
        app.emit('open-file', { preventDefault() {} }, filePath)
      }, unsupportedPath)
      await expect(
        page.locator('[data-tab-id]').filter({ hasText: 'unsupported.txt' })
      ).toHaveCount(0)
      const unauthorizedRead = await page.evaluate(async (filePath) => {
        try {
          await window.api.fs.readFile({ filePath })
          return 'allowed'
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }, unsupportedPath)
      expect(unauthorizedRead).toContain('Access denied')
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused()
          )
        )
      ).toBe(true)
    } finally {
      if (launched) {
        await session.close(launched.app)
      }
      await session.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
