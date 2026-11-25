/**
 * E2E tests for moving a split terminal pane into its own tab on a local workspace.
 *
 * User Prompt:
 * - drag a terminal split to a top-level tab of its own; it must keep its shell, scrollback and
 *   name, and work without a drag too
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { focusActiveTerminalInput, waitForPaneIdentitySnapshot } from '../input/terminal'
import { waitForActiveTerminalManager, waitForPaneCount } from './terminal-pane-operations'
import { dragPaneOutToTabStrip } from '../../layout/publication/terminal-layout-journeys'
import { getTerminalContentForPtyId } from '../lifecycle/terminal-pty-readiness'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from '../../agents/session-fixtures/native-chat-transcript-fixture'
import { waitForActivePaneHookDescriptor } from '../input/terminal-active-pane'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'

async function waitForTerminalOutputForPtyId(
  page: Page,
  ptyId: string,
  expected: string,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(async () => (await getTerminalContentForPtyId(page, ptyId, 8000)).includes(expected), {
      timeout: timeoutMs,
      message: `Terminal PTY ${ptyId} did not contain "${expected}"`
    })
    .toBe(true)
}

const SPLIT_RIGHT_CHORD = process.platform === 'darwin' ? 'Meta+d' : 'Control+Shift+d'
const SEARCH_EVERYTHING_CHORD = process.platform === 'darwin' ? 'Meta+k' : 'Control+k'
// The move has no default chord; a user binds one. F9 keeps clear of Alt's character remapping.
const MOVE_PANE_BINDING = 'Mod+Shift+F9'
const MOVE_PANE_CHORD = process.platform === 'darwin' ? 'Meta+Shift+F9' : 'Control+Shift+F9'

type TabState = { worktreeId: string; activeTabId: string | null; order: string[] }

async function readTabs(page: Page): Promise<TabState> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const groupId = state.activeGroupIdByWorktree[worktreeId]
    const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === groupId)
    const unified = state.unifiedTabsByWorktree[worktreeId] ?? []
    const order = (group?.tabOrder ?? []).map(
      (id) => unified.find((tab) => tab.id === id)?.entityId ?? id
    )
    return { worktreeId, activeTabId: state.activeTabId, order }
  })
}

/** The tab now holding a leaf, with that leaf's PTY there. */
async function readLeafHome(
  page: Page,
  leafId: string
): Promise<{ tabId: string; ptyId: string | undefined; leafCount: number } | null> {
  return page.evaluate((leafId) => {
    const layouts = window.__store!.getState().terminalLayoutsByTabId
    for (const [tabId, layout] of Object.entries(layouts)) {
      const ptyId = layout?.ptyIdsByLeafId?.[leafId]
      if (ptyId) {
        return { tabId, ptyId, leafCount: Object.keys(layout.ptyIdsByLeafId ?? {}).length }
      }
    }
    return null
  }, leafId)
}

async function splitWithMarker(
  page: Page
): Promise<{ leafId: string; ptyId: string; marker: string }> {
  await waitForPaneIdentitySnapshot(page, 1)
  await focusActiveTerminalInput(page)
  await page.keyboard.press(SPLIT_RIGHT_CHORD)
  await waitForPaneCount(page, 2)
  const snapshot = await waitForPaneIdentitySnapshot(page, 2)
  const leafId = snapshot.activeLeafId
  const ptyId = leafId ? snapshot.ptyIdsByLeafId[leafId] : undefined
  if (!leafId || !ptyId) {
    throw new Error(`No bound active pane in ${JSON.stringify(snapshot)}`)
  }
  const marker = `MOVE_SCROLLBACK_${Date.now()}`
  await focusActiveTerminalInput(page)
  await page.keyboard.type(`echo ${marker}\r`)
  await waitForTerminalOutputForPtyId(page, ptyId, marker, 10_000)
  return { leafId, ptyId, marker }
}

async function expectMovedToOwnTab(
  page: Page,
  moved: { leafId: string; ptyId: string; marker: string },
  sourceTabId: string
): Promise<string> {
  await expect
    .poll(async () => (await readLeafHome(page, moved.leafId))?.tabId ?? null)
    .not.toBe(sourceTabId)
  const home = await readLeafHome(page, moved.leafId)
  expect(home).toEqual({ tabId: expect.any(String), ptyId: moved.ptyId, leafCount: 1 })
  await expect.poll(async () => (await readTabs(page)).activeTabId).toBe(home!.tabId)
  // Same shell: the scrollback is still there and new input reaches it.
  await waitForTerminalOutputForPtyId(page, moved.ptyId, moved.marker, 10_000)
  const typed = `MOVE_FOCUS_${Date.now()}`
  await page.keyboard.type(`echo ${typed}\r`)
  await waitForTerminalOutputForPtyId(page, moved.ptyId, typed, 10_000)
  return home!.tabId
}

/**
 * Splits, then opens a real conversation on the new split leaf in chat view, so the chat view's
 * own pane menu and composer mount. The caller removes the transcript folder.
 */
async function openChatOnSplit(page: Page) {
  const moved = await splitWithMarker(page)
  const before = await readTabs(page)
  const sourceTabId = before.activeTabId!
  const descriptor = await waitForActivePaneHookDescriptor(page)
  expect(descriptor.paneKey).toBe(`${sourceTabId}:${moved.leafId}`)
  const sessionId = `e2e-move-chat-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-move-chat-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  const reply = `MOVE_CHAT_REPLY_${Date.now()}`
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({ sessionId, userText: 'Is the build done?', assistantText: reply })
  )
  await enableNativeChatSetting(page)
  await seedClaudeProviderSession(page, { ...descriptor, sessionId, transcriptPath })
  await toggleTerminalTabToChatView(page, { tabId: sourceTabId, worktreeId: before.worktreeId })
  const sourceTab = page.locator(`[data-terminal-tab-id="${sourceTabId}"]`)
  const sourceReply = sourceTab.locator('[data-native-chat-window]').getByText(reply)
  await expect(sourceReply).toBeVisible({ timeout: 30_000 })
  const composer = sourceTab.locator('[data-native-chat-composer-scope]')
  await expect(composer).toBeVisible()
  expect(
    await page.evaluate(
      (tabId) => window.__store!.getState().terminalLayoutsByTabId[tabId]?.chatLeafId ?? null,
      sourceTabId
    )
  ).toBe(moved.leafId)
  const sibling = await page.evaluate(
    ({ tabId, leafId }) =>
      Object.entries(
        window.__store!.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
      ).find(([id]) => id !== leafId) ?? null,
    { tabId: sourceTabId, leafId: moved.leafId }
  )
  expect(sibling).not.toBeNull()
  return { moved, before, sourceTabId, reply, sourceReply, composer, sibling: sibling!, scratchDir }
}

/** The pane left with its shell and conversation for a new tab in chat view; its sibling stayed. */
async function expectChatMovedToOwnTab(
  page: Page,
  chat: Awaited<ReturnType<typeof openChatOnSplit>>
) {
  await expect
    .poll(async () => (await readLeafHome(page, chat.moved.leafId))?.tabId ?? null)
    .not.toBe(chat.sourceTabId)
  const home = await readLeafHome(page, chat.moved.leafId)
  expect(home).toEqual({ tabId: expect.any(String), ptyId: chat.moved.ptyId, leafCount: 1 })
  expect(await readLeafHome(page, chat.sibling[0])).toEqual({
    tabId: chat.sourceTabId,
    ptyId: chat.sibling[1],
    leafCount: 1
  })
  expect(
    await page.evaluate(
      ({ tabId, worktreeId }) =>
        window
          .__store!.getState()
          .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === tabId)?.viewMode,
      { tabId: home!.tabId, worktreeId: chat.before.worktreeId }
    )
  ).toBe('chat')
  await expect(
    page
      .locator(`[data-terminal-tab-id="${home!.tabId}"] [data-native-chat-window]`)
      .getByText(chat.reply)
  ).toBeVisible({ timeout: 30_000 })
  await waitForTerminalOutputForPtyId(page, chat.moved.ptyId, chat.moved.marker, 10_000)
}

// Why: keep the suite serial so headful pane tests never open multiple Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Move a terminal pane to a new tab', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('dragging a pane onto the tab strip moves its live shell into a new tab', async ({
    orcaPage
  }) => {
    const moved = await splitWithMarker(orcaPage)
    const before = await readTabs(orcaPage)

    await dragPaneOutToTabStrip(orcaPage, before.worktreeId, moved.leafId, 'end')

    const newTabId = await expectMovedToOwnTab(orcaPage, moved, before.activeTabId!)
    expect((await readTabs(orcaPage)).order.at(-1)).toBe(newTabId)
  })

  test('Escape cancels a pane drag without sending Escape to the shell', async ({ orcaPage }) => {
    const pane = await splitWithMarker(orcaPage)
    const before = await readTabs(orcaPage)
    // cat -v prints a received Escape byte as ^[.
    await orcaPage.keyboard.type('cat -v\r')

    const handle = orcaPage.locator(`.pane[data-leaf-id="${pane.leafId}"] .pane-drag-handle`)
    const strip = orcaPage
      .locator(`[data-tab-group-strip-id][data-worktree-id="${before.worktreeId}"]`)
      .first()
    const handleBox = (await handle.boundingBox())!
    const stripBox = (await strip.boundingBox())!
    await orcaPage.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 4)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(stripBox.x + stripBox.width - 8, stripBox.y + stripBox.height / 2, {
      steps: 20
    })
    await expect(orcaPage.locator('.pane-drop-overlay')).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.locator('.pane-drop-overlay')).toHaveCount(0)
    await orcaPage.mouse.up()

    const marker = `AFTER_ESC_${Date.now()}`
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type(`${marker}\r`)
    // Typed once, echoed once by cat: two copies mean cat read the line.
    await expect
      .poll(
        async () =>
          (await getTerminalContentForPtyId(orcaPage, pane.ptyId, 8000)).split(marker).length - 1
      )
      .toBeGreaterThanOrEqual(2)
    expect(await getTerminalContentForPtyId(orcaPage, pane.ptyId, 8000)).not.toContain('^[')
    // Positive control: the same check sees an Escape that is not cancelling a drag.
    const control = `CONTROL_${Date.now()}`
    await orcaPage.keyboard.press('Escape')
    await orcaPage.keyboard.type(`${control}\r`)
    await expect
      .poll(async () => getTerminalContentForPtyId(orcaPage, pane.ptyId, 8000))
      .toContain(`^[${control}`)
    await orcaPage.keyboard.press('Control+c')
    expect(await readTabs(orcaPage)).toEqual(before)
    expect((await readLeafHome(orcaPage, pane.leafId))?.tabId).toBe(before.activeTabId)
  })

  test('a drag across the first terminal row selects text instead of moving the pane', async ({
    orcaPage
  }) => {
    const pane = await splitWithMarker(orcaPage)
    const before = await readTabs(orcaPage)
    const box = (await orcaPage.locator(`.pane[data-leaf-id="${pane.leafId}"]`).boundingBox())!

    // Row 1 sits under the grip strip; start left of the centred grip tab, in its height.
    await orcaPage.mouse.move(box.x + 6, box.y + 4)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(box.x + box.width / 2 - 40, box.y + 4, { steps: 10 })
    await expect(orcaPage.locator('.is-pane-dragging')).toHaveCount(0)
    await orcaPage.mouse.up()

    expect(
      await orcaPage.evaluate(
        ({ tabId, leafId }) =>
          window.__paneManagers
            ?.get(tabId)
            ?.getPanes()
            .find((entry) => entry.leafId === leafId)
            ?.terminal.hasSelection() ?? false,
        { tabId: before.activeTabId!, leafId: pane.leafId }
      )
    ).toBe(true)
    expect(await readTabs(orcaPage)).toEqual(before)
  })

  test('the pane menu moves a pane into a new tab right after its own', async ({ orcaPage }) => {
    const moved = await splitWithMarker(orcaPage)
    const before = await readTabs(orcaPage)

    await orcaPage.locator(`.pane[data-leaf-id="${moved.leafId}"] .xterm-screen`).click({
      button: 'right'
    })
    await orcaPage.getByRole('menuitem', { name: 'Move to New Tab' }).click()

    const newTabId = await expectMovedToOwnTab(orcaPage, moved, before.activeTabId!)
    const order = (await readTabs(orcaPage)).order
    expect(order.indexOf(newTabId)).toBe(order.indexOf(before.activeTabId!) + 1)
  })

  test('the search palette moves the active pane into a new tab', async ({ orcaPage }) => {
    const moved = await splitWithMarker(orcaPage)
    const before = await readTabs(orcaPage)

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(SEARCH_EVERYTHING_CHORD)
    const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(palette).toBeVisible()
    await palette.locator('[cmdk-input]').fill('Move Pane to New Tab')
    await expect(palette.locator('[cmdk-item]').first()).toContainText('Move Pane to New Tab')
    await palette.locator('[cmdk-input]').press('Enter')
    await expect(palette).toHaveCount(0)

    await expectMovedToOwnTab(orcaPage, moved, before.activeTabId!)
  })

  test('a shortcut the user binds moves the active pane, and does nothing unbound or alone', async ({
    orcaPage
  }) => {
    const moved = await splitWithMarker(orcaPage)
    const before = await readTabs(orcaPage)

    // Unbound by default: the chord moves nothing.
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(MOVE_PANE_CHORD)
    await orcaPage.waitForTimeout(500)
    expect(await readTabs(orcaPage)).toEqual(before)

    await orcaPage.evaluate(
      (binding) =>
        window.__store!.getState().setKeybindingOverride('terminal.movePaneToNewTab', [binding]),
      MOVE_PANE_BINDING
    )
    try {
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.press(MOVE_PANE_CHORD)
      const newTabId = await expectMovedToOwnTab(orcaPage, moved, before.activeTabId!)

      // The moved pane is alone in its tab now: the same chord leaves it there.
      await orcaPage.keyboard.press(MOVE_PANE_CHORD)
      await orcaPage.waitForTimeout(500)
      expect((await readLeafHome(orcaPage, moved.leafId))?.tabId).toBe(newTabId)
    } finally {
      await orcaPage.evaluate(() =>
        window.__store!.getState().resetKeybindingOverride('terminal.movePaneToNewTab')
      )
    }
  })

  test('the chat view pane menu moves a pane into a new tab that opens in chat view', async ({
    orcaPage
  }) => {
    const chat = await openChatOnSplit(orcaPage)
    try {
      // The transcript is not editable, so this is the chat view's own pane menu.
      await chat.sourceReply.click({ button: 'right' })
      const chatMenu = orcaPage.locator('[data-native-chat-context-menu]')
      await expect(chatMenu).toBeVisible()
      await chatMenu.getByRole('menuitem', { name: 'Move to New Tab' }).click()

      await expectChatMovedToOwnTab(orcaPage, chat)
    } finally {
      rmSync(chat.scratchDir, { recursive: true, force: true })
    }
  })

  test('a bound shortcut moves the pane from its chat composer', async ({ orcaPage }) => {
    await orcaPage.evaluate(
      (binding) =>
        window.__store!.getState().setKeybindingOverride('terminal.movePaneToNewTab', [binding]),
      MOVE_PANE_BINDING
    )
    const chat = await openChatOnSplit(orcaPage)
    try {
      await chat.composer.locator('textarea, [contenteditable="true"]').first().click()
      await orcaPage.keyboard.press(MOVE_PANE_CHORD)

      await expectChatMovedToOwnTab(orcaPage, chat)
    } finally {
      rmSync(chat.scratchDir, { recursive: true, force: true })
      await orcaPage.evaluate(() =>
        window.__store!.getState().resetKeybindingOverride('terminal.movePaneToNewTab')
      )
    }
  })
})
