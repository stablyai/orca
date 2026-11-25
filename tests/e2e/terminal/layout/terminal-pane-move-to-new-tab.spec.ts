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

/** The tab whose pane tree holds a leaf, with that leaf's PTY there and the tree's leaf count. */
async function readLeafHome(
  page: Page,
  leafId: string
): Promise<{ tabId: string; ptyId: string | undefined; leafCount: number } | null> {
  return page.evaluate((leafId) => {
    type PaneNode =
      | { type: 'leaf'; leafId: string }
      | { type: 'split'; first: PaneNode; second: PaneNode }
    const leavesOf = (node: PaneNode | null | undefined): string[] =>
      !node
        ? []
        : node.type === 'leaf'
          ? [node.leafId]
          : [...leavesOf(node.first), ...leavesOf(node.second)]
    const layouts = window.__store!.getState().terminalLayoutsByTabId
    for (const [tabId, layout] of Object.entries(layouts)) {
      const leaves = leavesOf(layout?.root)
      if (leaves.includes(leafId)) {
        return { tabId, ptyId: layout?.ptyIdsByLeafId?.[leafId], leafCount: leaves.length }
      }
    }
    return null
  }, leafId)
}

/** The terminal tabs that have a mounted pane for this leaf: one, the tab that holds it. */
async function mountedLeafOwners(page: Page, leafId: string): Promise<(string | null)[]> {
  return page.evaluate(
    (leafId) =>
      [...document.querySelectorAll(`.pane[data-leaf-id="${CSS.escape(leafId)}"]`)].map(
        (pane) =>
          pane.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id') ?? null
      ),
    leafId
  )
}

/** A leaf's live pane in one tab: the PTY its pane is bound to and what its terminal shows. */
type LeafOwner = { tabId: string; leafId: string; ptyId: string }

/** Reads the leaf's pane from that tab's own manager only; null when the tab does not hold it. */
async function readLeafOutput(
  page: Page,
  tabId: string,
  leafId: string
): Promise<{ ptyId: string | undefined; text: string } | null> {
  return page.evaluate(
    ({ tabId, leafId }) => {
      const pane = window.__paneManagers
        ?.get(tabId)
        ?.getPanes()
        .find((candidate) => candidate.leafId === leafId)
      return pane
        ? {
            ptyId: pane.container.dataset.ptyId,
            text: pane.serializeAddon.serialize().slice(-8000)
          }
        : null
    },
    { tabId, leafId }
  )
}

/** The text appears in this tab's pane for this leaf, and that pane is bound to this PTY. */
async function waitForLeafOutput(page: Page, owner: LeafOwner, expected: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const output = await readLeafOutput(page, owner.tabId, owner.leafId)
        return output?.ptyId === owner.ptyId && output.text.includes(expected)
      },
      { timeout: 10_000, message: `${owner.tabId}/${owner.leafId} did not show "${expected}"` }
    )
    .toBe(true)
}

/**
 * Runs a command whose output is not in the bytes typed (they hold the two halves apart), so
 * seeing it in the owner's pane proves its shell ran it, not just that the PTY echoed the keys.
 */
async function runInShell(page: Page, owner: LeafOwner, label: string): Promise<string> {
  const stamp = `${Date.now()}`
  await page.keyboard.type(`printf '%s_%s\\n' ${label} ${stamp}\r`)
  const output = `${label}_${stamp}`
  await waitForLeafOutput(page, owner, output)
  return output
}

type SplitPane = {
  leafId: string
  ptyId: string
  marker: string
  sourceTabId: string
  sibling: { leafId: string; ptyId: string }
}

async function splitWithMarker(page: Page): Promise<SplitPane> {
  await waitForPaneIdentitySnapshot(page, 1)
  await focusActiveTerminalInput(page)
  await page.keyboard.press(SPLIT_RIGHT_CHORD)
  await waitForPaneCount(page, 2)
  const snapshot = await waitForPaneIdentitySnapshot(page, 2)
  const leafId = snapshot.activeLeafId
  const ptyId = leafId ? snapshot.ptyIdsByLeafId[leafId] : undefined
  const sibling = Object.entries(snapshot.ptyIdsByLeafId).find(([id]) => id !== leafId)
  if (!leafId || !ptyId || !sibling) {
    throw new Error(`No bound split in ${JSON.stringify(snapshot)}`)
  }
  await focusActiveTerminalInput(page)
  const marker = await runInShell(page, { tabId: snapshot.tabId, leafId, ptyId }, 'MOVE_SCROLLBACK')
  return {
    leafId,
    ptyId,
    marker,
    sourceTabId: snapshot.tabId,
    sibling: { leafId: sibling[0], ptyId: sibling[1] }
  }
}

/**
 * The pane left with its shell for a new tab: the new tab's own pane for the leaf is bound to the
 * same PTY, shows the scrollback and runs new input; the source no longer has a pane for it; the
 * sibling stayed in the source with its own shell.
 */
async function expectPaneOwnedByNewTab(page: Page, moved: SplitPane): Promise<LeafOwner> {
  await expect
    .poll(async () => (await readLeafHome(page, moved.leafId))?.tabId ?? null)
    .not.toBe(moved.sourceTabId)
  const home = await readLeafHome(page, moved.leafId)
  expect(home).toEqual({ tabId: expect.any(String), ptyId: moved.ptyId, leafCount: 1 })
  expect(await readLeafHome(page, moved.sibling.leafId)).toEqual({
    tabId: moved.sourceTabId,
    ptyId: moved.sibling.ptyId,
    leafCount: 1
  })
  await expect.poll(() => mountedLeafOwners(page, moved.leafId)).toEqual([home!.tabId])
  const owner = { tabId: home!.tabId, leafId: moved.leafId, ptyId: moved.ptyId }
  await waitForLeafOutput(page, owner, moved.marker)
  // Wrong-owner control: the same witness read through the source tab finds no pane for the leaf.
  expect(await readLeafOutput(page, moved.sourceTabId, moved.leafId)).toBeNull()
  return owner
}

async function expectMovedToOwnTab(page: Page, moved: SplitPane): Promise<string> {
  const owner = await expectPaneOwnedByNewTab(page, moved)
  await expect.poll(async () => (await readTabs(page)).activeTabId).toBe(owner.tabId)
  // Typed into the new tab with nothing clicked: focus followed the pane.
  await runInShell(page, owner, 'MOVE_FOCUS')
  return owner.tabId
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
  return { moved, before, sourceTabId, reply, sourceReply, composer, scratchDir }
}

/** The pane left with its shell and conversation for a new tab in chat view; its sibling stayed. */
async function expectChatMovedToOwnTab(
  page: Page,
  chat: Awaited<ReturnType<typeof openChatOnSplit>>
) {
  const owner = await expectPaneOwnedByNewTab(page, chat.moved)
  expect(
    await page.evaluate(
      ({ tabId, worktreeId }) =>
        window
          .__store!.getState()
          .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === tabId)?.viewMode,
      { tabId: owner.tabId, worktreeId: chat.before.worktreeId }
    )
  ).toBe('chat')
  const destination = page.locator(`[data-terminal-tab-id="${owner.tabId}"]`)
  await expect(destination.locator('[data-native-chat-window]').getByText(chat.reply)).toBeVisible({
    timeout: 30_000
  })
  // The moved conversation takes a fresh draft in its new tab.
  const draft = `MOVE_DRAFT_${Date.now()}`
  const editor = destination
    .locator('[data-native-chat-composer-scope]')
    .locator('textarea, [contenteditable="true"]')
    .first()
  await editor.click()
  await page.keyboard.type(draft)
  await expect
    .poll(() =>
      editor.evaluate((element) =>
        element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? '')
      )
    )
    .toContain(draft)
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

    const newTabId = await expectMovedToOwnTab(orcaPage, moved)
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

    const newTabId = await expectMovedToOwnTab(orcaPage, moved)
    const order = (await readTabs(orcaPage)).order
    expect(order.indexOf(newTabId)).toBe(order.indexOf(before.activeTabId!) + 1)
  })

  test('the search palette moves the active pane into a new tab', async ({ orcaPage }) => {
    const moved = await splitWithMarker(orcaPage)

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(SEARCH_EVERYTHING_CHORD)
    const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(palette).toBeVisible()
    await palette.locator('[cmdk-input]').fill('Move Pane to New Tab')
    await expect(palette.locator('[cmdk-item]').first()).toContainText('Move Pane to New Tab')
    await palette.locator('[cmdk-input]').press('Enter')
    await expect(palette).toHaveCount(0)

    await expectMovedToOwnTab(orcaPage, moved)
  })

  test('a shortcut the user binds moves the active pane, and does nothing unbound or alone', async ({
    orcaPage
  }) => {
    const moved = await splitWithMarker(orcaPage)
    const before = await readTabs(orcaPage)

    // Unbound by default: the chord moves nothing. Like any unbound key it reaches the shell (xterm
    // encodes it as an escape sequence), so the line is abandoned before the shell is used again,
    // and a command run in the source pane proves the pane stayed and its shell is clean.
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(MOVE_PANE_CHORD)
    await orcaPage.waitForTimeout(500)
    expect(await readTabs(orcaPage)).toEqual(before)
    await orcaPage.keyboard.press('Control+c')
    await runInShell(
      orcaPage,
      { tabId: moved.sourceTabId, leafId: moved.leafId, ptyId: moved.ptyId },
      'MOVE_UNBOUND'
    )

    await orcaPage.evaluate(
      (binding) =>
        window.__store!.getState().setKeybindingOverride('terminal.movePaneToNewTab', [binding]),
      MOVE_PANE_BINDING
    )
    try {
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.press(MOVE_PANE_CHORD)
      const newTabId = await expectMovedToOwnTab(orcaPage, moved)

      // The moved pane is alone in its tab now: the same chord leaves it there.
      await orcaPage.keyboard.press(MOVE_PANE_CHORD)
      await orcaPage.waitForTimeout(500)
      expect((await readLeafHome(orcaPage, moved.leafId))?.tabId).toBe(newTabId)
      // It reached the shell like an unbound key; leave the line clean for later tests.
      await orcaPage.keyboard.press('Control+c')
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
