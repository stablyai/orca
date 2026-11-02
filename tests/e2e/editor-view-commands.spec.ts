import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { KeybindingActionId } from '../../src/shared/keybindings'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'
import { disablePluginSystem, enableDevPlugins, openRepoFile } from './helpers/plugin-smoke'
import {
  focusInGuest,
  ISOLATED_FRAMES_E2E,
  pluginGuest,
  readInGuest
} from './helpers/plugin-frame-guest'

test.use(ISOLATED_FRAMES_E2E)
test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

type EditorCommandActionId = Extract<
  KeybindingActionId,
  'editor.toggleChanges' | 'editor.cycleViewMode'
>

const TOGGLE_CHANGES: EditorCommandActionId = 'editor.toggleChanges'
const CYCLE_VIEW: EditorCommandActionId = 'editor.cycleViewMode'
const TOGGLE_CHORD = 'ControlOrMeta+Alt+Shift+F8'
const CYCLE_CHORD = 'ControlOrMeta+Alt+Shift+F9'

async function setCommandBinding(
  page: Page,
  actionId: EditorCommandActionId,
  binding: string[]
): Promise<void> {
  await page.evaluate(
    async ({ actionId, binding }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Editor store is unavailable')
      }
      await state.setKeybindingOverride(actionId, binding)
    },
    { actionId, binding }
  )
}

async function resetCommandBindings(page: Page): Promise<void> {
  await page.evaluate(
    async ([toggleChanges, cycleView]) => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      await state.resetKeybindingOverride(toggleChanges)
      await state.resetKeybindingOverride(cycleView)
    },
    [TOGGLE_CHANGES, CYCLE_VIEW]
  )
}

async function readEditorState(
  page: Page,
  fileId: string
): Promise<{
  markdownView: string | null
  editorView: string | null
  draft: string | null
} | null> {
  return page.evaluate((fileId: string) => {
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    return {
      markdownView: state.markdownViewMode[fileId] ?? null,
      editorView: state.editorViewMode[fileId] ?? null,
      draft: state.editorDrafts[fileId] ?? null
    }
  }, fileId)
}

test.afterEach(async ({ orcaPage }) => {
  await resetCommandBindings(orcaPage)
})

test.describe('configurable editor view commands', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('Settings lists both actions without default bindings', async ({ orcaPage }) => {
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
      window.__store?.getState().openSettingsPage()
    })
    await orcaPage.getByPlaceholder('Search settings').fill('shortcuts')
    const search = orcaPage.getByPlaceholder('Search command or keys')
    await expect(search).toBeVisible()

    await search.fill('Toggle Changes')
    await expect(
      orcaPage.getByRole('button', { name: 'Add shortcut for Toggle Changes' })
    ).toBeVisible()
    await search.fill('Cycle Editor View')
    await expect(
      orcaPage.getByRole('button', { name: 'Add shortcut for Cycle Editor View' })
    ).toBeVisible()
  })

  test('toggles and cycles Markdown modes while keeping the unsaved draft', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const filePath = await createMarkdownFixture(
      context,
      'markdown-modes',
      testInfo.workerIndex,
      '# View commands\n\nInitial content.\n'
    )
    registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
    await setCommandBinding(orcaPage, TOGGLE_CHANGES, ['Mod+Alt+Shift+F8'])
    await setCommandBinding(orcaPage, CYCLE_VIEW, ['Mod+Alt+Shift+F9'])
    const activeFile = await openMarkdownFixture(orcaPage, context, filePath)
    const richEditor = await waitForRichMarkdownEditor(orcaPage)
    const marker = 'unsaved-view-command-marker'
    const state = () => readEditorState(orcaPage, activeFile.filePath)

    await richEditor.click()
    await orcaPage.keyboard.press('ControlOrMeta+End')
    await orcaPage.keyboard.type(`\n${marker}`)
    await expect.poll(async () => (await state())?.draft).toContain(marker)
    await orcaPage.screenshot({ path: testInfo.outputPath('editor-view-before.png') })

    await orcaPage.keyboard.press(TOGGLE_CHORD)
    await expect.poll(async () => (await state())?.editorView).toBe('changes')
    await expect(orcaPage.locator('.monaco-editor').first()).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('editor-view-after.png') })

    const changesButton = orcaPage.getByRole('radio', { name: 'Changes', exact: true })
    await changesButton.focus()
    await orcaPage.keyboard.press(TOGGLE_CHORD)
    await expect.poll(async () => (await state())?.editorView).not.toBe('changes')
    await expect(richEditor).toBeVisible()
    expect((await state())?.draft).toContain(marker)

    await orcaPage.getByRole('radio', { name: 'Source', exact: true }).click()
    const sourceEditor = orcaPage.locator('.monaco-editor').first()
    await expect(sourceEditor).toBeVisible()
    await expect(sourceEditor.locator('.view-lines')).toContainText(marker)
    await sourceEditor.click()
    await orcaPage.keyboard.press('ControlOrMeta+End')
    await orcaPage.keyboard.type(' source-marker')
    await expect.poll(async () => (await state())?.draft).toContain('source-marker')

    // The current toolbar order for this Markdown file is Source, Rich, Changes.
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.markdownView).toBe('rich')
    await expect.poll(async () => (await state())?.editorView).not.toBe('changes')
    await expect(richEditor).toBeVisible()
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.editorView).toBe('changes')
    await orcaPage.locator('.monaco-editor').first().click()
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.editorView).not.toBe('changes')
    await expect.poll(async () => (await state())?.markdownView).toBe('source')
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.markdownView).toBe('rich')
    await expect.poll(async () => (await state())?.editorView).not.toBe('changes')
    expect((await state())?.draft).toContain(marker)
    expect((await state())?.draft).toContain('source-marker')
  })

  test('a focused parent editor command flushes a custom editor before switching modes', async ({
    orcaPage,
    seededRepoPath
  }) => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-editor-view-command-plugin-'))
    const fileName = `view-command-${Date.now()}.sketch`
    const filePath = join(seededRepoPath, fileName)
    const editorHtml = `<textarea id="doc" style="width:100%;height:90vh"></textarea>
<script>
const doc = document.getElementById('doc')
let timer = null
let version = 0
const flush = () => {
  clearTimeout(timer); timer = null
  return orca.document.applyEdit({ baseVersion: version, content: { kind: 'text', text: doc.value } })
}
doc.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 400) })
orca.document.onDidChange((next) => { version = next.version; doc.value = next.content.text })
orca.on('editor.flush', () => (timer ? flush() : undefined))
</script>`

    try {
      await writeFile(filePath, 'initial frame text\n')
      await writeFile(
        join(pluginRoot, 'orca-plugin.json'),
        JSON.stringify(
          {
            manifestVersion: 2,
            execution: 'sandboxed-ui',
            id: 'view-command-editor',
            publisher: 'samples',
            name: 'View Command Editor',
            version: '1.0.0',
            engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
            contributes: {
              customEditors: [
                {
                  id: 'sketch',
                  title: 'Sketch Pad',
                  extensions: ['.sketch'],
                  entry: 'editor/index.html'
                }
              ]
            }
          },
          null,
          2
        )
      )
      await mkdir(join(pluginRoot, 'editor'), { recursive: true })
      await writeFile(join(pluginRoot, 'editor', 'index.html'), editorHtml)
      await enableDevPlugins(orcaPage, [pluginRoot])
      await setCommandBinding(orcaPage, TOGGLE_CHANGES, ['Mod+Alt+Shift+F8'])
      await openRepoFile(orcaPage, seededRepoPath, fileName)

      const guest = pluginGuest(orcaPage, 'Sketch Pad')
      const guestText = () => readInGuest<string>(guest, `document.getElementById('doc').value`)
      await expect(guest).toBeVisible({ timeout: 15_000 })
      await expect.poll(guestText).toBe('initial frame text\n')
      await focusInGuest(guest, '#doc')
      await orcaPage.keyboard.press('ControlOrMeta+End')
      await orcaPage.keyboard.type('unsaved plugin frame marker')
      await expect
        .poll(() =>
          orcaPage.evaluate(
            (name) =>
              window.__store?.getState().openFiles.find((file) => file.relativePath === name)
                ?.isDirty,
            fileName
          )
        )
        .toBe(true)

      // The command is issued from Orca's parent toolbar, not delivered into the plugin iframe.
      await orcaPage.getByRole('radio', { name: 'Sketch Pad', exact: true }).focus()
      await orcaPage.keyboard.press(TOGGLE_CHORD)
      await expect
        .poll(() =>
          orcaPage.evaluate((name) => {
            const state = window.__store?.getState()
            const file = state?.openFiles.find((entry) => entry.relativePath === name)
            return file ? state?.editorViewMode[file.id] : null
          }, fileName)
        )
        .toBe('changes')

      const changesButton = orcaPage.getByRole('radio', { name: 'Changes', exact: true })
      await changesButton.focus()
      await orcaPage.keyboard.press(TOGGLE_CHORD)
      await expect(guest).toBeVisible({ timeout: 15_000 })
      await expect.poll(guestText).toContain('unsaved plugin frame marker')
    } finally {
      await disablePluginSystem(orcaPage).catch(() => undefined)
      await rm(filePath, { force: true })
      await rm(pluginRoot, { recursive: true, force: true })
    }
  })
})
