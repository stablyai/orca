import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, type Locator, type Page } from '@stablyai/playwright-test'
import type { KeybindingActionId } from '../../src/shared/keybindings/types'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { test } from './desktop/electron-fixtures/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './desktop/renderer-probes/store'

const ISOLATED_FRAMES_E2E = { orcaAppExtraEnv: { ORCA_PLUGIN_ISOLATED_FRAMES: '1' } }

test.use(ISOLATED_FRAMES_E2E)
test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

type ActiveWorktreeContext = {
  worktreeId: string
  rootPath: string
}

async function getActiveWorktreeContext(page: Page): Promise<ActiveWorktreeContext> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree is selected')
    }
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    if (!worktree) {
      throw new Error(`Active worktree was not found in store: ${worktreeId}`)
    }
    return { worktreeId, rootPath: worktree.path }
  })
}

async function createMarkdownFixture(
  context: ActiveWorktreeContext,
  initialMarkdown: string
): Promise<string> {
  const directory = join(context.rootPath, 'markdown-modes')
  await mkdir(directory, { recursive: true })
  const filePath = join(directory, `view-commands-${Date.now()}.md`)
  await writeFile(filePath, initialMarkdown, 'utf8')
  return filePath
}

async function openMarkdownFixture(
  page: Page,
  context: ActiveWorktreeContext,
  filePath: string
): Promise<{ filePath: string }> {
  const relativePath = relative(context.rootPath, filePath)
  await page.evaluate(
    ({ filePath, relativePath, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openFile({
        filePath,
        relativePath,
        worktreeId,
        language: 'markdown',
        mode: 'edit'
      })
    },
    { filePath, relativePath, worktreeId: context.worktreeId }
  )

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const store = window.__store
          if (!store) {
            return null
          }
          const state = store.getState()
          const file = state.openFiles.find((entry) => entry.id === state.activeFileId)
          return file?.filePath ?? null
        }),
      { timeout: 5_000, message: `Active editor file did not become ${filePath}` }
    )
    .toBe(filePath)

  return { filePath }
}

async function waitForRichMarkdownEditor(page: Page): Promise<Locator> {
  const editor = page.locator('.rich-markdown-editor')
  await expect(editor).toBeVisible({ timeout: 25_000 })
  return editor
}

async function enableDevPlugins(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(async (devPluginPaths) => {
    const settings = await window.api.settings.set({ pluginSystemEnabled: true, devPluginPaths })
    window.__store?.setState({ settings })
    for (const plugin of await window.api.plugins.refresh()) {
      if (plugin.isDev && plugin.status === 'pending' && plugin.consentFingerprint) {
        await window.api.plugins.consent({
          pluginKey: plugin.pluginKey,
          reviewedFingerprint: plugin.consentFingerprint,
          decision: 'approve'
        })
      }
    }
  }, paths)
}

async function disablePluginSystem(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({
      pluginSystemEnabled: false,
      devPluginPaths: []
    })
    window.__store?.setState({ settings })
    await window.api.plugins.refresh()
  })
}

async function openRepoFile(page: Page, repoPath: string, name: string): Promise<void> {
  await page.evaluate(
    ({ name, filePath }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('no active worktree')
      }
      state.openFile({
        filePath,
        relativePath: name,
        worktreeId: state.activeWorktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
    },
    { name, filePath: join(repoPath, name) }
  )
}

function pluginGuest(page: Page, title: string): Locator {
  return page.locator(`webview[title="${title}"]`)
}

async function evalInGuest<T>(guest: Locator, source: string): Promise<T> {
  const result: T = await guest.evaluate(
    (webview: Electron.WebviewTag, script: string) => webview.executeJavaScript(script),
    source
  )
  return result
}

async function readInGuest<T>(guest: Locator, source: string): Promise<T | null> {
  try {
    return await evalInGuest<T>(guest, source)
  } catch {
    return null
  }
}

async function focusInGuest(guest: Locator, selector: string): Promise<void> {
  const target = `document.querySelector(${JSON.stringify(selector)})`
  await expect
    .poll(async () => {
      try {
        await guest.evaluate((webview: Electron.WebviewTag) => webview.focus())
        await evalInGuest(guest, `${target}?.focus()`)
        const hostFocused = await guest.evaluate(
          (webview: Electron.WebviewTag) => webview.ownerDocument.activeElement === webview
        )
        return (
          hostFocused && (await evalInGuest<boolean>(guest, `document.activeElement === ${target}`))
        )
      } catch {
        return false
      }
    })
    .toBe(true)
}

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
    await orcaPage.getByRole('option', { name: /Shortcuts Interface/ }).click()
    const search = orcaPage.getByPlaceholder('Search command or keys')
    await expect(search).toBeVisible()

    await search.fill('Toggle Changes')
    await expect(
      orcaPage.getByRole('button', { name: 'Add shortcut for Toggle Changes', exact: true })
    ).toBeVisible()
    await search.fill('Cycle Editor View')
    await expect(
      orcaPage.getByRole('button', { name: 'Add shortcut for Cycle Editor View', exact: true })
    ).toBeVisible()
  })

  test('toggles and cycles Markdown modes while keeping the unsaved draft', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    const filePath = await createMarkdownFixture(context, '# View commands\n\nInitial content.\n')
    registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
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
    const sourceRadio = orcaPage.getByRole('radio', { name: 'Source', exact: true })
    const richRadio = orcaPage.getByRole('radio', { name: 'Rich Editor', exact: true })
    const monacoEditor = orcaPage.locator('.monaco-editor').first()
    await expect(monacoEditor).toBeVisible()
    await expect(monacoEditor.locator('.view-lines')).toContainText(marker)
    await monacoEditor.click()
    await orcaPage.keyboard.press('ControlOrMeta+End')
    await orcaPage.keyboard.type(' source-marker')
    await expect.poll(async () => (await state())?.draft).toContain('source-marker')

    // The current toolbar order for this Markdown file is Source, Rich, Changes.
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.markdownView).toBe('rich')
    await expect.poll(async () => (await state())?.editorView).not.toBe('changes')
    await expect(richEditor).toBeVisible()
    await expect(richRadio).toHaveAttribute('aria-checked', 'true')
    await expect(richEditor).toBeFocused()
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.editorView).toBe('changes')
    await expect(monacoEditor).toBeVisible()
    await expect(changesButton).toHaveAttribute('aria-checked', 'true')
    await monacoEditor.click()
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.editorView).not.toBe('changes')
    await expect.poll(async () => (await state())?.markdownView).toBe('source')
    await expect(monacoEditor).toBeVisible()
    await expect(sourceRadio).toHaveAttribute('aria-checked', 'true')
    await orcaPage.keyboard.press(CYCLE_CHORD)
    await expect.poll(async () => (await state())?.markdownView).toBe('rich')
    await expect.poll(async () => (await state())?.editorView).not.toBe('changes')
    expect((await state())?.draft).toContain(marker)
    expect((await state())?.draft).toContain('source-marker')
    await expect(richEditor).toBeVisible()
    await expect(richRadio).toHaveAttribute('aria-checked', 'true')
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
let version = 0
let pending = false
const flush = () => {
  if (!pending) return undefined
  return orca.document.applyEdit({ baseVersion: version, content: { kind: 'text', text: doc.value } }).then(() => { pending = false })
}
doc.addEventListener('input', () => { pending = true })
orca.document.onDidChange((next) => { version = next.version; doc.value = next.content.text })
orca.on('editor.flush', () => (pending ? flush() : undefined))
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
      await expect.poll(guestText).toContain('unsaved plugin frame marker')
      const parentFileState = (): Promise<{
        isDirty: boolean
        draft: string | null
      } | null> =>
        orcaPage.evaluate((name) => {
          const state = window.__store?.getState()
          const file = state?.openFiles.find((entry) => entry.relativePath === name)
          return file && state
            ? { isDirty: file.isDirty, draft: state.editorDrafts[file.id] ?? null }
            : null
        }, fileName)
      await expect.poll(parentFileState).toMatchObject({ isDirty: false })

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
      await expect(changesButton).toBeVisible()
      await expect(changesButton).toHaveAttribute('aria-checked', 'true')
      await expect.poll(parentFileState).toMatchObject({
        isDirty: true,
        draft: expect.stringContaining('unsaved plugin frame marker')
      })
      const activeEditorPanel = changesButton.locator(
        "xpath=ancestor::div[.//div[contains(@class, 'monaco-diff-editor')]][1]"
      )
      await expect(
        activeEditorPanel.locator(
          '.monaco-diff-editor:visible .monaco-editor.modified-in-monaco-diff-editor'
        )
      ).toContainText('unsaved plugin frame marker')

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
