import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { parseIpynb } from '../../src/renderer/src/components/editor/ipynb-parse'

const FIRST = { id: 'first', source: 'print("original")' }
const SECOND = { id: 'second', source: 'print("other")' }

function notebookContent(cells: { id: string; source: string }[]): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: cells.map(({ id, source }) => ({
      id,
      cell_type: 'code',
      metadata: {},
      execution_count: null,
      outputs: [],
      source: [source]
    }))
  })
}

async function openNotebook(page: Page, filePath: string): Promise<void> {
  const context = await getActiveWorktreeContext(page)
  await page.evaluate(
    ({ filePath, worktreeId, relativePath }) => {
      window.__store?.getState().openFile({
        filePath,
        relativePath,
        worktreeId,
        language: 'json',
        mode: 'edit'
      })
    },
    {
      filePath,
      worktreeId: context.worktreeId,
      relativePath: path.relative(context.rootPath, filePath)
    }
  )
  await expect(page.locator('.ipynb-code-surface')).toHaveCount(2)
}

async function fileIsDirty(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    return state?.openFiles.find((file) => file.id === state.activeFileId)?.isDirty ?? null
  })
}

test.beforeEach(async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
})

for (const reload of ['source', 'reorder'] as const) {
  test(`keeps the active cell current after an external notebook ${reload} reload`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const directory = path.join(context.rootPath, '.orca-e2e-notebook-external-sync')
    await mkdir(directory, { recursive: true })
    const filePath = path.join(directory, `${reload}-${testInfo.workerIndex}-${randomUUID()}.ipynb`)
    registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
    await writeFile(filePath, notebookContent([FIRST, SECOND]), 'utf8')
    await openNotebook(orcaPage, filePath)
    const surfaces = orcaPage.locator('.ipynb-code-surface')
    await surfaces.first().getByRole('button').click()
    await expect(orcaPage.locator('.ipynb-code-surface .monaco-editor')).toBeVisible()
    await expect.poll(() => fileIsDirty(orcaPage)).toBe(false)

    const updatedFirst = reload === 'source' ? { ...FIRST, source: 'print("updated")' } : FIRST
    const updatedSecond = { ...SECOND, source: 'print("reload marker")' }
    const externalCells =
      reload === 'source' ? [updatedFirst, updatedSecond] : [updatedSecond, updatedFirst]
    await writeFile(filePath, notebookContent(externalCells), 'utf8')
    const preview = surfaces.nth(reload === 'source' ? 1 : 0)
    await expect(preview).toHaveText(updatedSecond.source, { timeout: 25_000 })
    await expect.poll(() => fileIsDirty(orcaPage)).toBe(false)
    await orcaPage.screenshot({ path: testInfo.outputPath('external-reload-clean.png') })
    const activeCell = surfaces.nth(reload === 'source' ? 0 : 1)
    await expect.soft(activeCell.locator('.view-lines')).toHaveText(updatedFirst.source)

    await orcaPage.keyboard.press('End')
    await orcaPage.keyboard.type('!', { delay: 100 })
    await expect.poll(() => fileIsDirty(orcaPage)).toBe(true)
    await orcaPage.screenshot({ path: testInfo.outputPath('external-reload-cell-edit.png') })
    await orcaPage.getByRole('button', { name: 'Save notebook', exact: true }).click()
    const editedFirst = { ...updatedFirst, source: `${updatedFirst.source}!` }
    await expect
      .poll(async () => {
        const saved = parseIpynb(await readFile(filePath, 'utf8'))
        return saved.cells.map(({ id, source }) => ({ id, source }))
      })
      .toEqual(reload === 'source' ? [editedFirst, updatedSecond] : [updatedSecond, editedFirst])
    await expect.poll(() => fileIsDirty(orcaPage)).toBe(false)
    await orcaPage.screenshot({ path: testInfo.outputPath('external-reload-cell-saved.png') })
  })
}
