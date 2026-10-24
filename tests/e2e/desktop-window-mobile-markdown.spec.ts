/**
 * A phone reads and saves a Markdown tab on a desktop whose editor holds unsaved text for it.
 *
 * The phone always works on the file on disk, window or not: it sees the disk with the tab marked
 * dirty, and its save lands on disk. The desktop keeps its unsaved text and reports the newer disk
 * content with its usual changed-on-disk banner.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult
} from '../../src/shared/mobile-markdown-document'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient } from './helpers/paired-mobile-client'

const DISK = '# Shared notes\n\nOn disk.\n'
const DRAFT_LINE = 'unsaved desktop line'
const PHONE = '# Shared notes\n\nSaved from the phone.\n'
const BANNER = 'This file changed on disk while you have unsaved edits.'

test('a phone saves a Markdown tab the desktop has unsaved edits in, without touching them', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-phone-markdown',
    'desktop-draft',
    testInfo.workerIndex,
    DISK
  )
  const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
  try {
    await openMarkdownFixture(orcaPage, context, filePath)
    const editor = await waitForRichMarkdownEditor(orcaPage)
    await expect(editor).toContainText('On disk.')
    await editor.click()
    await orcaPage.keyboard.press('ControlOrMeta+End')
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.insertText(DRAFT_LINE)
    const desktopDraft = () =>
      orcaPage.evaluate((path) => {
        const state = window.__store!.getState()
        const file = state.openFiles.find((entry) => entry.filePath === path)
        return {
          draft: file ? state.editorDrafts[file.id] : undefined,
          isDirty: file?.isDirty === true,
          externalMutation: file?.externalMutation ?? null
        }
      }, filePath)
    await expect.poll(async () => (await desktopDraft()).draft ?? '').toContain(DRAFT_LINE)
    const before = await desktopDraft()
    expect(before.isDirty).toBe(true)

    const worktree = `id:${context.worktreeId}`
    let tabId = ''
    await expect
      .poll(
        async () => {
          const listed = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
            worktree
          })
          const tab = listed.tabs.find(
            (entry) => entry.type === 'markdown' && entry.sourceFilePath === filePath
          )
          tabId = tab?.id ?? ''
          return tab?.type === 'markdown' && tab.isDirty
        },
        { timeout: 30_000, message: 'the desktop never listed its dirty Markdown tab' }
      )
      .toBe(true)

    // Why poll: the desktop persists its session (which names the file) on a debounce.
    let read: RuntimeMarkdownReadTabResult | null = null
    await expect
      .poll(
        async () => {
          const response = await phone.request<RuntimeMarkdownReadTabResult>('markdown.readTab', {
            worktree,
            tabId
          })
          read = response.ok ? response.result : null
          return response.ok ? 'read' : `${response.error.code}: ${response.error.message}`
        },
        { timeout: 30_000 }
      )
      .toBe('read')
    expect(read).toMatchObject({
      tabId,
      filePath,
      content: DISK,
      source: 'file',
      isDirty: true,
      editable: true
    })

    const saved = await phone.call<RuntimeMarkdownSaveTabResult>('markdown.saveTab', {
      worktree,
      tabId,
      baseVersion: read!.version,
      content: PHONE
    })
    expect(saved).toMatchObject({ tabId, isDirty: false, content: PHONE })
    expect(readFileSync(filePath, 'utf8')).toBe(PHONE)

    await expect(orcaPage.getByText(BANNER)).toBeVisible({ timeout: 30_000 })
    await testInfo.attach('desktop-after-phone-save', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    const after = await desktopDraft()
    expect(after).toEqual({ ...before, externalMutation: 'changed' })
    await expect(editor).toContainText(DRAFT_LINE)
    expect(readFileSync(filePath, 'utf8')).toBe(PHONE)
  } finally {
    phone.dispose()
    await cleanupMarkdownFixture(filePath)
  }
})

test("a phone reads the desktop's unsaved untitled Markdown tab read-only and never saves it", async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
  let untitledPath = ''
  try {
    untitledPath = await orcaPage.evaluate(async (worktreeId) => {
      const store = window.__store!
      const before = new Set(store.getState().openFiles.map((file) => file.id))
      const groupId = store.getState().activeGroupIdByWorktree[worktreeId] ?? ''
      await store.getState().openNewMarkdownInActiveWorkspace(groupId)
      const created = store
        .getState()
        .openFiles.find((file) => !before.has(file.id) && file.isUntitled === true)
      if (!created) {
        throw new Error('No untitled Markdown tab was created')
      }
      return created.filePath
    }, context.worktreeId)
    const editor = await waitForRichMarkdownEditor(orcaPage)
    await editor.click()
    await orcaPage.keyboard.insertText(DRAFT_LINE)
    await expect
      .poll(() =>
        orcaPage.evaluate((path) => {
          const state = window.__store!.getState()
          const file = state.openFiles.find((entry) => entry.filePath === path)
          return file?.isDirty === true && file.isUntitled === true
        }, untitledPath)
      )
      .toBe(true)

    const worktree = `id:${context.worktreeId}`
    let tabId = ''
    await expect
      .poll(async () => {
        const listed = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
          worktree
        })
        tabId =
          listed.tabs.find(
            (entry) => entry.type === 'markdown' && entry.sourceFilePath === untitledPath
          )?.id ?? ''
        return tabId
      })
      .not.toBe('')

    // Why poll: the desktop persists its session (which names the file) on a debounce.
    let read: RuntimeMarkdownReadTabResult | null = null
    await expect
      .poll(
        async () => {
          const response = await phone.request<RuntimeMarkdownReadTabResult>('markdown.readTab', {
            worktree,
            tabId
          })
          read = response.ok ? response.result : null
          return response.ok ? 'read' : `${response.error.code}: ${response.error.message}`
        },
        { timeout: 30_000 }
      )
      .toBe('read')
    const disk = readFileSync(untitledPath, 'utf8')
    expect(read).toMatchObject({
      tabId,
      filePath: untitledPath,
      content: disk,
      source: 'file',
      isDirty: true,
      editable: false,
      readOnlyReason: 'unsupported_untitled'
    })
    expect(JSON.stringify(read)).not.toContain(DRAFT_LINE)

    const save = await phone.request('markdown.saveTab', {
      worktree,
      tabId,
      baseVersion: read!.version,
      content: PHONE
    })
    expect(save).toMatchObject({ ok: false, error: { message: 'unsupported_untitled' } })
    expect(readFileSync(untitledPath, 'utf8')).toBe(disk)

    // With no file on disk the read fails, and a save still makes none.
    rmSync(untitledPath)
    const missingRead = await phone.request('markdown.readTab', { worktree, tabId })
    testInfo.annotations.push({
      type: 'untitled-missing-read',
      description: JSON.stringify(missingRead.ok ? missingRead.result : missingRead.error)
    })
    expect(missingRead.ok).toBe(false)
    const missingSave = await phone.request('markdown.saveTab', {
      worktree,
      tabId,
      baseVersion: read!.version,
      content: PHONE
    })
    expect(missingSave).toMatchObject({ ok: false, error: { message: 'unsupported_untitled' } })
    expect(existsSync(untitledPath)).toBe(false)
  } finally {
    phone.dispose()
    if (untitledPath) {
      await cleanupMarkdownFixture(untitledPath)
    }
  }
})
