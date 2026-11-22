import { readFileSync } from 'node:fs'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './markdown-editor-fixture'
import {
  expectEditableNestedToggles,
  expectFileKeepsNesting,
  expectSentinelInsideNestedToggle,
  NESTED_TOGGLE_FIXTURE_DIRECTORY,
  NESTED_TOGGLE_MARKDOWN,
  placeCaretInNestedToggleBody
} from './markdown-nested-toggle'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'

test.describe('Markdown nested toggle regression', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('editing a nested toggle survives save and reopen', async ({ orcaPage }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const sentinel = `editedInsideNestedToggle${Date.now()}`
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'nested-toggle-edit',
        testInfo.workerIndex,
        NESTED_TOGGLE_MARKDOWN
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      await waitForRichMarkdownEditor(orcaPage)
      await expectEditableNestedToggles(orcaPage)

      await placeCaretInNestedToggleBody(orcaPage)
      await orcaPage.keyboard.type(` ${sentinel}`)
      await expectSentinelInsideNestedToggle(orcaPage, sentinel)

      // Save through the real shortcut and assert the bytes that landed on disk.
      await orcaPage.keyboard.press('ControlOrMeta+S')
      const savedPath = filePath
      await expect
        .poll(() => readFileSync(savedPath, 'utf8'), { timeout: 10_000 })
        .toContain(sentinel)
      expectFileKeepsNesting(readFileSync(savedPath, 'utf8'), sentinel)

      // Reopen the saved bytes from scratch; the reported bug appeared only after reparsing.
      await closeActiveEditorTab(orcaPage, savedPath)
      await openMarkdownFixture(orcaPage, context, savedPath)
      await waitForRichMarkdownEditor(orcaPage)
      await expectEditableNestedToggles(orcaPage)
      await expectSentinelInsideNestedToggle(orcaPage, sentinel)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
