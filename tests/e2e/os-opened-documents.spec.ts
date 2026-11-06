import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/constants'

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
    const refusedPath =
      process.platform === 'darwin' ? path.join(root, 'directory.txt') : unsupportedPath
    if (process.platform === 'darwin') {
      mkdirSync(refusedPath)
    }
    const session = createRestartSession(testInfo, {
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1'
    })
    let launched: Awaited<ReturnType<typeof session.launch>> | undefined
    try {
      launched = await session.launch({ extraArgs: [coldPath, pathToFileURL(coldPath).href] })
      const { app, page } = launched
      // OS-opened CSVs are editable, so they render as an ARIA grid rather than a table.
      const grid = page.getByRole('grid', { name: 'CSV editor' })
      const coldResult =
        extension === 'md'
          ? page.getByRole('heading', { name: 'Cold result' })
          : grid.getByRole('gridcell', { name: 'Cold result', exact: true })
      const warmResult =
        extension === 'md'
          ? page.getByRole('heading', { name: 'Warm result' })
          : grid.getByRole('gridcell', { name: 'Warm result', exact: true })
      await expect(coldResult).toBeVisible()
      await expect(page.getByText('42', { exact: true })).toBeVisible()
      await expect(
        page.locator('[data-tab-id]').filter({ hasText: `cold.${extension}` })
      ).toHaveCount(1)
      const coldProof = testInfo.outputPath('cold-open.png')
      await page.screenshot({ path: coldProof })
      await testInfo.attach('cold-open', { path: coldProof, contentType: 'image/png' })

      await app.evaluate(({ app }, fileUrl) => {
        const prefix = process.argv.slice(0, process.defaultApp ? 2 : 1)
        app.emit('second-instance', {}, [...prefix, fileUrl], process.cwd())
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
      }, refusedPath)
      await expect(
        page.locator('[data-tab-id]').filter({ hasText: path.basename(refusedPath) })
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

test('macOS opens and saves a cold-start code file in place', async ({
  seedTestRepo
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'Additional OS file types are macOS-only.')
  void seedTestRepo
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-os-code-')))
  const filePath = path.join(root, 'package.json')
  writeFileSync(filePath, '{"result":"COLD_CODE_MARKER"}\n')
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch({ extraArgs: [filePath, pathToFileURL(filePath).href] })
    const { app, page } = launched
    const editor = page.locator('.monaco-editor:visible')
    await expect(editor.locator('.view-lines')).toContainText('COLD_CODE_MARKER')
    await expect(page.locator('[data-tab-id]').filter({ hasText: 'package.json' })).toHaveCount(1)
    await editor.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await expect(editor.locator('.view-lines')).not.toContainText('COLD_CODE_MARKER')
    const savedContent = '{"result":"SAVED_CODE_MARKER"}\n'
    await page.keyboard.insertText(savedContent)
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(savedContent)
    await expect(editor.locator('.view-lines')).toContainText('SAVED_CODE_MARKER')
    const proof = testInfo.outputPath('code-saved.png')
    await page.screenshot({ path: proof })
    await testInfo.attach('code-saved', { path: proof, contentType: 'image/png' })
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
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

test('macOS opens warm code, configuration and unnamed text files without opening its entrypoint', async ({
  seedTestRepo
}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'Additional OS file types are macOS-only.')
  void seedTestRepo
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-os-warm-code-')))
  const files = [
    ['source.ts', 'export const marker = "WARM_TS_MARKER"\n', 'WARM_TS_MARKER'],
    ['script.py', 'marker = "WARM_PY_MARKER"\n', 'WARM_PY_MARKER'],
    ['config.yaml', 'marker: WARM_YAML_MARKER\n', 'WARM_YAML_MARKER'],
    ['notes.txt', 'WARM_TEXT_MARKER\n', 'WARM_TEXT_MARKER'],
    ['Dockerfile', 'FROM scratch\n# WARM_DOCKER_MARKER\n', 'WARM_DOCKER_MARKER'],
    ['.env', 'MARKER=WARM_ENV_MARKER\n', 'WARM_ENV_MARKER'],
    ['代码 notes.custom', 'WARM_CUSTOM_MARKER\n', 'WARM_CUSTOM_MARKER']
  ] as const
  for (const [name, content] of files) {
    writeFileSync(path.join(root, name), content)
  }
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    const { app, page } = launched
    await waitForSessionReady(page)
    await expect(page.locator('[data-tab-id]').filter({ hasText: 'index.js' })).toHaveCount(0)
    for (const [name, , marker] of files) {
      const filePath = path.join(root, name)
      await app.evaluate(({ app }, filePath) => {
        app.emit('open-file', { preventDefault() {} }, filePath)
      }, filePath)
      await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText(marker)
      await expect(page.locator('[data-tab-id]').filter({ hasText: name })).toHaveCount(1)
      const owner = await page.evaluate((filePath) => {
        const file = window.__store
          ?.getState()
          .openFiles.find((entry) => entry.filePath === filePath)
        return {
          worktreeId: file?.worktreeId,
          runtimeEnvironmentId: file?.runtimeEnvironmentId ?? null
        }
      }, filePath)
      expect(owner).toEqual({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null
      })
    }
    const lastName = files.at(-1)![0]
    await app.evaluate(
      ({ app }, fileUrl) => {
        const prefix = process.argv.slice(0, process.defaultApp ? 2 : 1)
        app.emit('second-instance', {}, [...prefix, fileUrl], process.cwd())
      },
      pathToFileURL(path.join(root, lastName)).href
    )
    await expect(page.locator('[data-tab-id]').filter({ hasText: lastName })).toHaveCount(1)
    const proof = testInfo.outputPath('warm-code-open.png')
    await page.screenshot({ path: proof })
    await testInfo.attach('warm-code-open', { path: proof, contentType: 'image/png' })
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
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
