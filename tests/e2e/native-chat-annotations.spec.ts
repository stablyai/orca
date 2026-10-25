import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { claudeTranscriptLines } from './helpers/native-chat-transcript-fixture'

const FIRST = 'The controller compensates the measured disturbance.'
const SECOND = 'The observer estimates the remaining disturbance.'

test('conversation annotations preserve quotes, highlight passages and collect editable comments', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setSize(1280, 900)
    }
  })
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-annotations-${randomUUID()}`
  const transcriptPath = join(
    mkdtempSync(join(tmpdir(), 'orca-annotation-transcript-')),
    `${sessionId}.jsonl`
  )
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({
      sessionId,
      userText: 'Explain the controller and observer.',
      assistantText: `${FIRST}\n\n${SECOND}`
    })
  )
  await orcaPage.evaluate(
    async ({ paneKey, worktreeId, sessionId, transcriptPath, tabId }) => {
      const settings = await window.api.settings.set({
        experimentalNativeChat: true,
        uiLanguage: 'en',
        theme: 'dark'
      })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings })
      const state = store.getState()
      state.setAgentStatus(
        paneKey,
        { state: 'done', agentType: 'claude', prompt: 'annotation review' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
      )
      if (!tab) {
        throw new Error('Terminal unavailable')
      }
      state.toggleTabViewMode(tab.id)
    },
    { ...descriptor, sessionId, transcriptPath, tabId }
  )

  const root = orcaPage.locator('[data-native-chat-root="true"]')
  const first = root.getByText(FIRST, { exact: true })
  const second = root.getByText(SECOND, { exact: true })
  await expect(first).toBeVisible()
  await first.click({ clickCount: 3 })
  await orcaPage.getByRole('button', { name: 'Add annotation', exact: true }).click()
  const tray = root.getByRole('region', { name: 'Annotations', exact: true })
  const editor = root.getByRole('dialog', { name: 'Comment', exact: true })
  await editor
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('Explain how the measured signal enters the controller.')
  const editorBounds = await editor.boundingBox()
  const passageBounds = await first.boundingBox()
  expect(
    editorBounds &&
      passageBounds &&
      Math.abs(editorBounds.y + editorBounds.height - passageBounds.y) < 100
  ).toBe(true)
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await editor.screenshot({
    path: testInfo.outputPath('annotation-editor-closeup.png'),
    animations: 'disabled'
  })
  await expect(root.locator('[data-native-chat-annotation-marker="1"]')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('annotation-floating-editor.png') })
  await editor.getByRole('button', { name: 'Save annotation', exact: true }).click()
  await expect(tray).toHaveCount(0)
  await expect(
    root
      .locator('.bg-chat-composer-surface')
      .getByRole('button', { name: '1 annotation', exact: true })
  ).toBeVisible()
  await expect(root.locator('[data-native-chat-annotation-marker="1"]')).toBeVisible()
  await expect(root.getByRole('textbox')).toBeEmpty()
  await expect
    .poll(() =>
      orcaPage.evaluate(() =>
        [...CSS.highlights.keys()].some((name) => name.startsWith('native-chat-annotation-'))
      )
    )
    .toBe(true)

  await second.click({ clickCount: 3 })
  await second.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Add annotation', exact: true }).click()
  await editor
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('State the physical units of the estimate.')
  await editor.getByRole('button', { name: 'Save annotation', exact: true }).click()
  await root.getByRole('button', { name: '2 annotations', exact: true }).click()
  await expect(tray.getByRole('listitem')).toHaveCount(2)
  await tray.getByRole('button', { name: 'Edit annotation', exact: true }).first().click()
  await editor
    .getByRole('textbox', { name: 'Comment', exact: true })
    .fill('Explain the measured signal and its control effect.')
  await editor.getByRole('button', { name: 'Save annotation', exact: true }).click()
  await orcaPage.screenshot({ path: testInfo.outputPath('annotations-collapsed-desktop.png') })
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  appendFileSync(
    transcriptPath,
    Array.from({ length: 60 }, (_, index) =>
      claudeTranscriptLines({
        sessionId,
        messageIdPrefix: `${sessionId}-later-${index}`,
        userText: `Later question ${index}`,
        assistantText: `Later answer ${index}. ${'Measured signal and controller response. '.repeat(20)}`
      })
    ).join('')
  )
  const scroller = root.locator('[data-native-chat-scroll]')
  await expect(
    root.locator('[data-native-chat-quote-source]').filter({ hasText: 'Later answer 59.' })
  ).toBeVisible({ timeout: 30_000 })
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  const original = root.locator('[data-native-chat-quote-source]').filter({ hasText: FIRST })
  await expect(original).toHaveCount(0)
  await root.getByRole('button', { name: '2 annotations', exact: true }).click()
  await tray.getByRole('button', { name: 'Show original text', exact: true }).first().click()
  await expect(original).toBeVisible()
  await expect
    .poll(async () =>
      original.evaluate((element) => {
        const viewport = element.closest('[data-native-chat-scroll]')?.getBoundingClientRect()
        const bounds = element.getBoundingClientRect()
        return (
          viewport !== undefined && bounds.bottom > viewport.top && bounds.top < viewport.bottom
        )
      })
    )
    .toBe(true)
  await orcaPage.screenshot({
    path: testInfo.outputPath('annotation-original-after-virtualization.png')
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('annotations-desktop.png') })

  await orcaPage.setViewportSize({ width: 720, height: 800 })
  await orcaPage.evaluate(() =>
    window.__store?.setState({ sidebarOpen: false, rightSidebarOpen: false })
  )
  await expect.poll(async () => (await root.boundingBox())?.width ?? 0).toBeGreaterThan(600)
  const bounds = await tray.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(721)
  expect(await tray.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('annotations-narrow.png') })
  await tray.getByRole('button', { name: 'Edit annotation', exact: true }).first().click()
  const narrowEditor = await editor.boundingBox()
  expect(narrowEditor && narrowEditor.x >= 0 && narrowEditor.x + narrowEditor.width <= 721).toBe(
    true
  )
  await editor.getByRole('textbox', { name: 'Comment', exact: true }).press('Enter')
  await expect(editor).toHaveCount(0)
  await root.getByRole('button', { name: '2 annotations', exact: true }).click()
  await orcaPage.evaluate(async () => {
    const settings = await window.api.settings.set({ uiLanguage: 'zh', theme: 'light' })
    window.__store?.setState({ settings })
  })
  await expect(root.getByRole('button', { name: '2 条批注', exact: true })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('annotations-light-chinese.png') })
  await orcaPage.evaluate(async () => {
    const settings = await window.api.settings.set({ uiLanguage: 'en', theme: 'dark' })
    window.__store?.setState({ settings })
  })
  await tray.getByRole('button', { name: 'Delete annotation', exact: true }).first().click()
  await tray.getByRole('button', { name: 'Delete annotation', exact: true }).first().click()
  await expect(root.getByRole('textbox')).toBeEmpty()
  await orcaPage.evaluate(
    ({ quote }) => {
      const savedKey = Object.keys(localStorage).find(
        (key) => key.startsWith('orca:native-chat-annotations:v2:') && key.includes(':note:')
      )
      if (!savedKey) {
        throw new Error('Annotation scope unavailable')
      }
      const prefix = savedKey.slice(0, savedKey.indexOf(':note:'))
      const scope = decodeURIComponent(prefix.slice('orca:native-chat-annotations:v2:'.length))
      const source = [...document.querySelectorAll('[data-native-chat-quote-source]')].find(
        (element) => element.textContent?.includes(quote)
      )
      const row = source?.closest(
        '[data-native-chat-annotation-message-id], [data-native-chat-message-id]'
      )
      const messageId =
        row?.getAttribute('data-native-chat-annotation-message-id') ??
        row?.getAttribute('data-native-chat-message-id')
      if (!messageId) {
        throw new Error('Annotation message unavailable')
      }
      const anchor = { messageId, quote, startOffset: 0 }
      const key = `orca:native-chat-annotations:v1:${scope}`
      localStorage.removeItem(`${prefix}:editor`)
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          notes: [
            {
              ...anchor,
              id: 'legacy-quota-note',
              comment: 'Legacy note stays visible when migration fails.',
              createdAt: Date.now()
            }
          ],
          editor: { anchor, comment: 'Legacy unfinished comment.' }
        })
      )
      const write = Storage.prototype.setItem
      Storage.prototype.setItem = function (name, value) {
        if (name.startsWith(`${prefix}:legacy-`)) {
          throw new DOMException('Test quota refusal', 'QuotaExceededError')
        }
        write.call(this, name, value)
      }
      Object.defineProperty(window, '__restoreAnnotationMigrationStorage', {
        configurable: true,
        value: () => {
          Storage.prototype.setItem = write
        }
      })
      window.dispatchEvent(new StorageEvent('storage', { key }))
    },
    { quote: FIRST }
  )
  await expect(editor.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
    'Legacy unfinished comment.'
  )
  await expect(root.getByRole('status')).toContainText('Annotations could not be saved')
  await orcaPage.screenshot({ path: testInfo.outputPath('annotations-migration-refused.png') })
  await orcaPage.evaluate(() => {
    const restore: unknown = Reflect.get(window, '__restoreAnnotationMigrationStorage')
    if (typeof restore !== 'function') {
      throw new Error('Storage restore unavailable')
    }
    restore()
    Reflect.deleteProperty(window, '__restoreAnnotationMigrationStorage')
  })
  await root.getByRole('button', { name: 'Retry saving annotations', exact: true }).click()
  await expect(root.getByRole('status')).toHaveCount(0)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await root.getByRole('button', { name: '1 annotation', exact: true }).click()
  await expect(
    tray.getByText('Legacy note stays visible when migration fails.', { exact: true })
  ).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
