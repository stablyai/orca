import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_ADDED_LINE,
  GOLDEN_CHANGED_PATH,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

async function diffModelSnapshot(page: Page, bundle: string) {
  return page.evaluate(async (bundle) => {
    type Registry = {
      editor: {
        getModels(): {
          uri: { scheme: string; toString(): string }
          getValueLength(): number
          isAttachedToEditor(): boolean
        }[]
      }
    }
    function isRegistry(value: unknown): value is Registry {
      return (
        typeof value === 'object' &&
        value !== null &&
        'editor' in value &&
        typeof value.editor === 'object' &&
        value.editor !== null &&
        'getModels' in value.editor &&
        typeof value.editor.getModels === 'function'
      )
    }
    const module = await import(new URL(`./assets/${bundle}`, window.location.href).href)
    const registry = Object.values(module).find(isRegistry)
    if (!registry) {
      throw new Error('Bundled editor registry is unavailable')
    }
    return registry.editor
      .getModels()
      .filter((model) => model.uri.scheme === 'diff')
      .map((model) => ({
        uri: model.uri.toString(),
        length: model.getValueLength(),
        attached: model.isAttachedToEditor()
      }))
  }, bundle)
}

test('Changes models are released after returning to Edit and closing the real tab', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'changes-model-cleanup')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)
  const filePath = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)
  const bundle = readdirSync(path.join(process.cwd(), 'out', 'renderer', 'assets')).find(
    (entry) => entry.startsWith('monaco-setup-') && entry.endsWith('.js')
  )
  if (!bundle) {
    throw new Error('Build the E2E editor bundle before running this test')
  }
  await waitForSessionReady(orcaPage)
  const receipts: {
    iteration: number
    open: Awaited<ReturnType<typeof diffModelSnapshot>>
    closed: Awaited<ReturnType<typeof diffModelSnapshot>>
  }[] = []
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
    await orcaPage.evaluate(
      ({ filePath, relativePath }) => {
        const state = window.__store?.getState()
        if (!state?.activeWorktreeId) {
          throw new Error('Missing active editor workspace')
        }
        state.openFile({
          filePath,
          relativePath,
          worktreeId: state.activeWorktreeId,
          language: 'typescript',
          mode: 'edit'
        })
      },
      { filePath, relativePath: GOLDEN_CHANGED_PATH }
    )
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText('index.ts')
    await orcaPage.getByRole('radio', { name: 'Changes', exact: true }).click()
    await expect(orcaPage.locator('.monaco-diff-editor')).toBeVisible({ timeout: 25_000 })
    await expect(
      orcaPage.locator('.modified-in-monaco-diff-editor .view-lines[role=presentation]')
    ).toContainText(GOLDEN_ADDED_LINE)
    const open = await diffModelSnapshot(orcaPage, bundle)
    expect(open).toHaveLength(2)
    await orcaPage.screenshot({ path: testInfo.outputPath(`changes-${iteration}.png`) })
    await orcaPage.getByRole('radio', { name: 'Edit', exact: true }).click()
    await expect(orcaPage.locator('.monaco-diff-editor')).toHaveCount(0)
    const editorTab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'index.ts' }).first()
    await editorTab.hover()
    await editorTab.locator('[data-tab-close-button]').click()
    await expect(orcaPage.locator('.editor-header-path')).toHaveCount(0)
    await expect.poll(async () => (await diffModelSnapshot(orcaPage, bundle)).length).toBe(0)
    receipts.push({ iteration, open, closed: await diffModelSnapshot(orcaPage, bundle) })
  }
  const receiptPath = testInfo.outputPath('retained-models.json')
  writeFileSync(receiptPath, JSON.stringify(receipts, null, 2))
  await testInfo.attach('retained-models.json', { path: receiptPath, contentType: 'application/json' })
  await orcaPage.screenshot({ path: testInfo.outputPath('closed-editor.png') })
  await expect(orcaPage.locator('.monaco-diff-editor')).toHaveCount(0)
})
