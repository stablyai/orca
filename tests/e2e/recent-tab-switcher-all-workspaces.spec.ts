/**
 * E2E for the Ctrl+Tab switcher scopes (This workspace, All workspaces): the keyboard, the mouse,
 * a focused browser page or terminal, split panes, long lists, and Tab strip order. Writes the
 * switcher states and screenshots as artifacts.
 */

import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { startBrowserLinkServer } from './helpers/browser-link-server'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { focusActiveTerminalInput, waitForActivePanePtyId } from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'
import { worktreeRowSurface } from './worktree-row-locators'

type SwitcherSnapshot = {
  title: string
  box: { x: number; y: number; width: number; height: number }
  rows: { text: string; selected: boolean }[]
}

const TAB_NAMES = [
  'Terminal 1',
  'diff-note-layout.ts',
  'index.ts',
  'package.json',
  'Switcher chat',
  'Switcher page'
]

function switcher(page: Page) {
  return page.getByRole('listbox', { name: 'Switch tabs' })
}

async function readSwitcher(page: Page): Promise<SwitcherSnapshot> {
  await expect(switcher(page)).toBeVisible()
  return switcher(page).evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return {
      title: element.firstElementChild?.firstElementChild?.textContent ?? '',
      box: { x, y, width, height },
      rows: [...element.querySelectorAll('[role="option"]')].map((row) => ({
        text: row.textContent ?? '',
        selected: row.getAttribute('aria-selected') === 'true'
      }))
    }
  })
}

/** Opens the switcher, reads it, and cancels it; the Control release must not switch tabs. */
async function peekSwitcher(page: Page): Promise<SwitcherSnapshot> {
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  const snapshot = await readSwitcher(page)
  await page.keyboard.press('Escape')
  await expect(switcher(page)).toHaveCount(0)
  await page.keyboard.up('Control')
  return snapshot
}

function rowIndex(snapshot: SwitcherSnapshot, fileName: string): number {
  return snapshot.rows.findIndex((row) => row.text.includes(fileName))
}

function rowNames(snapshot: SwitcherSnapshot): string[] {
  return snapshot.rows.map((row) => TAB_NAMES.find((name) => row.text.includes(name)) ?? row.text)
}

async function getWorktreeIdsByBranch(
  page: Page
): Promise<{ primaryId: string; secondaryId: string }> {
  return page.evaluate(() => {
    const worktrees = Object.values(window.__store!.getState().worktreesByRepo).flat()
    const secondary = worktrees.find((worktree) => worktree.branch.includes('e2e-secondary'))
    const primary = worktrees.find((worktree) => worktree !== secondary)
    if (!primary || !secondary) {
      throw new Error('the seeded repo needs its primary and e2e-secondary worktrees')
    }
    return { primaryId: primary.id, secondaryId: secondary.id }
  })
}

async function openSeededFile(
  page: Page,
  worktreeId: string,
  relativePath: string,
  opts: { activate?: boolean } = {}
): Promise<void> {
  await page.evaluate(
    ({ wId, relPath, activate }) => {
      const state = window.__store!.getState()
      // Why: one task, so the empty-workspace check sees this tab and seeds no first terminal.
      if (activate) {
        state.setActiveWorktree(wId)
      }
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        throw new Error(`unknown worktree ${wId}`)
      }
      const separator = worktree.path.includes('\\') ? '\\' : '/'
      state.openFile({
        filePath: `${worktree.path}${separator}${relPath.split('/').join(separator)}`,
        relativePath: relPath,
        worktreeId: wId,
        language: relPath.endsWith('.json') ? 'json' : 'typescript',
        mode: 'edit'
      })
    },
    { wId: worktreeId, relPath: relativePath, activate: opts.activate === true }
  )
}

async function clickSidebarWorkspace(page: Page, worktreeId: string): Promise<void> {
  await worktreeRowSurface(page, worktreeId).click()
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktreeId
  )
}

async function clickTab(page: Page, name: string): Promise<void> {
  await page.locator('[data-tab-id]:visible').filter({ hasText: name }).click()
}

// Why: each call is its own task, like a click in a pane, which calls focusGroup on focus.
async function focusPane(page: Page, worktreeId: string, groupId: string): Promise<void> {
  await page.evaluate(({ wId, gId }) => window.__store!.getState().focusGroup(wId, gId), {
    wId: worktreeId,
    gId: groupId
  })
}

/** The pane that has the keyboard focus, or null when the focus is outside every pane. */
async function readFocusedPane(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.activeElement
        ?.closest('[data-tab-group-body-id]')
        ?.getAttribute('data-tab-group-body-id') ?? null
  )
}

const PAGE_CTRL_TAB: Electron.KeyboardInputEvent[] = [
  { type: 'keyDown', keyCode: 'Control', modifiers: ['control'] },
  { type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] },
  { type: 'keyUp', keyCode: 'Tab', modifiers: ['control'] }
]

/** Sends keys into the page's own process, the way they arrive when the page has the focus. */
async function sendKeysToPage(
  page: Page,
  browserTabId: string,
  keys: Electron.KeyboardInputEvent[]
): Promise<void> {
  await page.evaluate(
    async ({ tabId, keyEvents }) => {
      const webview = document.querySelector<Electron.WebviewTag>(
        `[data-browser-overlay-tab-id="${tabId}"] webview`
      )
      if (!webview) {
        throw new Error(`no page for browser tab ${tabId}`)
      }
      for (const keyEvent of keyEvents) {
        await webview.sendInputEvent(keyEvent)
      }
    },
    { tabId: browserTabId, keyEvents: keys }
  )
}

async function readPageTitle(page: Page, browserTabId: string): Promise<string> {
  return page.evaluate(async (tabId) => {
    const webview = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${tabId}"] webview`
    )
    try {
      return webview ? String(await webview.executeJavaScript('document.title')) : ''
    } catch {
      // Why: the page is not attached yet; the caller polls again.
      return ''
    }
  }, browserTabId)
}

test.describe('Ctrl+Tab switcher across workspaces', () => {
  test('Ctrl+A flips the scope mid-gesture; the list follows visits, opens chat and page rows, takes clicks, and keeps the scope', async ({
    orcaPage
  }, testInfo) => {
    const page = orcaPage
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await page.evaluate(async () => {
      // Why: the assertions read English strings; the host may run another system locale.
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    })
    const { primaryId, secondaryId } = await getWorktreeIdsByBranch(page)
    const activeTab = page.locator('[data-tab-id][data-active="true"]:visible')
    const steps: (SwitcherSnapshot & { step: string })[] = []

    // Focus history: package.json in the primary workspace, then index.ts and
    // diff-note-layout.ts in e2e-secondary. diff-note-layout.ts stays on screen.
    await switchToWorktree(page, primaryId)
    await openSeededFile(page, primaryId, 'package.json')
    await expect(activeTab).toContainText('package.json')
    // Why: the editor mounts before the switch, so it stays mounted behind e2e-secondary.
    await expect(
      page.locator('[data-tab-group-body-id] .monaco-editor:visible').first()
    ).toBeVisible()
    await openSeededFile(page, secondaryId, 'src/index.ts', { activate: true })
    await expect(activeTab).toContainText('index.ts')
    await openSeededFile(page, secondaryId, 'src/diff-note-layout.ts')
    await expect(activeTab).toContainText('diff-note-layout.ts')

    // A fresh profile opens on this workspace only.
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const workspaceScope = await readSwitcher(page)
    steps.push({ step: 'ctrl-tab', ...workspaceScope })
    expect(workspaceScope.title).toBe('Switch Tab · This workspace')
    expect(rowIndex(workspaceScope, 'index.ts')).toBeGreaterThanOrEqual(0)
    expect(rowIndex(workspaceScope, 'package.json')).toBe(-1)
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-this-workspace.png') })

    // Ctrl+A with Control still held lists every workspace by last focus.
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('All workspaces')
    const allScope = await readSwitcher(page)
    steps.push({ step: 'ctrl-a', ...allScope })
    expect(allScope.title).toBe('Switch Tab · All workspaces')
    // Only the row count can change the box: its top edge, left edge and width stay.
    expect({ x: allScope.box.x, y: allScope.box.y, width: allScope.box.width }).toEqual({
      x: workspaceScope.box.x,
      y: workspaceScope.box.y,
      width: workspaceScope.box.width
    })
    expect(rowIndex(allScope, 'diff-note-layout.ts')).toBe(0)
    expect(rowIndex(allScope, 'index.ts')).toBe(1)
    expect(allScope.rows[1].selected).toBe(true)
    expect(allScope.rows[1].text).toContain('e2e-secondary')
    const packageRow = rowIndex(allScope, 'package.json')
    expect(packageRow).toBeGreaterThan(1)
    expect(allScope.rows[packageRow].text).not.toContain('e2e-secondary')
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-all-workspaces.png') })

    // Tab down to the primary workspace's file and release Control.
    for (let index = 1; index < packageRow; index++) {
      await page.keyboard.press('Tab')
    }
    const beforeRelease = await readSwitcher(page)
    steps.push({ step: 'tab-to-package-json', ...beforeRelease })
    expect(beforeRelease.rows[packageRow].selected).toBe(true)
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect(activeTab).toContainText('package.json')
    // package.json stayed mounted behind e2e-secondary, so it takes the focus only from the switcher.
    const primaryPane = await page.evaluate(
      (wId) => window.__store!.getState().activeGroupIdByWorktree[wId],
      primaryId
    )
    await expect.poll(() => readFocusedPane(page)).toBe(primaryPane)

    // The scope sticks: the next Ctrl+Tab lists every workspace and selects the tab just left.
    const sticky = await peekSwitcher(page)
    steps.push({ step: 'sticky-ctrl-tab', ...sticky })
    expect(sticky.title).toBe('Switch Tab · All workspaces')
    expect(rowNames(sticky).slice(0, 2)).toEqual(['package.json', 'diff-note-layout.ts'])
    expect(sticky.rows[1].selected).toBe(true)
    await expect(activeTab).toContainText('package.json')

    // A workspace that a sidebar click shows counts as a visit, like a tab click.
    await page.evaluate(
      (ids) => {
        const state = window.__store!.getState()
        state.setSidebarOpen(true)
        for (const id of ids) {
          state.revealWorktreeInSidebar(id)
        }
      },
      [primaryId, secondaryId]
    )
    await clickTab(page, 'Terminal 1')
    await expect(activeTab).toContainText('Terminal 1')
    await clickSidebarWorkspace(page, secondaryId)
    await expect(activeTab).toContainText('diff-note-layout.ts')
    await clickSidebarWorkspace(page, primaryId)
    await expect(activeTab).toContainText('Terminal 1')
    const sidebarVisits = await peekSwitcher(page)
    steps.push({ step: 'sidebar-visits', ...sidebarVisits })
    expect
      .soft(rowNames(sidebarVisits))
      .toEqual(['Terminal 1', 'diff-note-layout.ts', 'package.json', 'index.ts'])

    // A pane that takes focus counts as a visit: package.json moves to its own
    // pane, index.ts gets a tab click, and then each pane takes focus in turn.
    const panes = await page.evaluate((wId) => {
      const state = window.__store!.getState()
      const editorTab = (state.unifiedTabsByWorktree[wId] ?? []).find(
        (tab) => tab.contentType === 'editor'
      )
      const terminalGroupId = editorTab?.groupId
      const editorGroupId = terminalGroupId
        ? state.createEmptySplitGroup(wId, terminalGroupId, 'right')
        : null
      if (!editorTab || !terminalGroupId || !editorGroupId) {
        throw new Error('the primary workspace did not split')
      }
      state.moveUnifiedTabToGroup(editorTab.id, editorGroupId)
      return { terminalGroupId, editorGroupId }
    }, primaryId)
    await focusPane(page, primaryId, panes.terminalGroupId)
    await clickSidebarWorkspace(page, secondaryId)
    await clickTab(page, 'index.ts')
    await expect(activeTab).toContainText('index.ts')
    await clickSidebarWorkspace(page, primaryId)
    await focusPane(page, primaryId, panes.editorGroupId)
    await focusPane(page, primaryId, panes.terminalGroupId)
    const paneVisits = await peekSwitcher(page)
    steps.push({ step: 'pane-focus-visits', ...paneVisits })
    expect
      .soft(rowNames(paneVisits))
      .toEqual(['Terminal 1', 'package.json', 'index.ts', 'diff-note-layout.ts'])

    // An agent chat is a row too: the chat just left comes second and opens in its workspace.
    await clickSidebarWorkspace(page, secondaryId)
    await page.evaluate((wId) => {
      const state = window.__store!.getState()
      state.createUnifiedTab(wId, 'agent-session', {
        id: 'structured-agent-session-e2e-switcher-chat',
        entityId: 'e2e-switcher-chat',
        executionHostId: 'local',
        agentSessionAgent: 'claude',
        label: 'Switcher chat',
        activate: true
      })
      state.setActiveTabType('agent-session', wId)
    }, secondaryId)
    await expect(activeTab).toContainText('Switcher chat')
    // Why: no activeTab check here; the split primary workspace shows two active tabs.
    await clickSidebarWorkspace(page, primaryId)
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const chatRows = await readSwitcher(page)
    steps.push({ step: 'agent-chat-row', ...chatRows })
    expect(rowNames(chatRows).slice(0, 2)).toEqual(['Terminal 1', 'Switcher chat'])
    expect(chatRows.rows[1].selected).toBe(true)
    expect(chatRows.rows[1].text).toContain('e2e-secondary')
    // The chat row shows its agent, as the tab strip does; the plain shell row shows none.
    const chatRowOptions = switcher(page).getByRole('option')
    await expect(chatRowOptions.nth(1).locator('[data-agent-icon="claude"]')).toHaveCount(1)
    await expect(chatRowOptions.nth(0).locator('[data-agent-icon]')).toHaveCount(0)
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      secondaryId
    )
    await expect(activeTab).toContainText('Switcher chat')

    // The open box takes every click: a click on the box stays in it, and a click on the
    // primary workspace's sidebar row closes the box without reaching the sidebar.
    const sidebarRow = await worktreeRowSurface(page, primaryId).boundingBox()
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const outsideClick = await readSwitcher(page)
    steps.push({ step: 'click-outside-box', ...outsideClick })
    if (!sidebarRow) {
      throw new Error('the primary sidebar row is not on screen')
    }
    expect(sidebarRow.x + sidebarRow.width).toBeLessThan(outsideClick.box.x)
    const boxTakesClicks = await switcher(page).evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(x + width / 2, y + height / 2))
    })
    expect(boxTakesClicks).toBe(true)
    await page.mouse.click(
      sidebarRow.x + sidebarRow.width / 2,
      sidebarRow.y + sidebarRow.height / 2
    )
    await expect(switcher(page)).toHaveCount(0)
    await page.keyboard.up('Control')
    await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      secondaryId
    )
    await expect(activeTab).toContainText('Switcher chat')

    // A browser page row opens its page in its own workspace.
    const browserTabId = await page.evaluate((wId) => {
      const state = window.__store!.getState()
      // Why: about:blank would name the row "New Tab"; this page keeps its title until it loads.
      const tab = state.createBrowserTab(wId, 'data:text/html,<title>Switcher page</title>', {
        title: 'Switcher page',
        activate: false
      })
      return tab.id
    }, primaryId)
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const pageRows = await readSwitcher(page)
    steps.push({ step: 'browser-page-row', ...pageRows })
    const pageRow = rowIndex(pageRows, 'Switcher page')
    expect(pageRow).toBeGreaterThan(1)
    expect(pageRows.rows[pageRow].text).not.toContain('e2e-secondary')
    // A click opens the row while Control is held; the release after it switches nothing.
    const pageRowBox = await switcher(page).getByRole('option').nth(pageRow).boundingBox()
    if (!pageRowBox) {
      throw new Error('the browser page row is not on screen')
    }
    await page.mouse.click(
      pageRowBox.x + pageRowBox.width / 2,
      pageRowBox.y + pageRowBox.height / 2
    )
    await expect(switcher(page)).toHaveCount(0)
    await page.keyboard.up('Control')
    await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      primaryId
    )
    // Why: by id, because the loaded page renames its tab to "New Tab".
    await expect(page.locator(`[data-tab-id="${browserTabId}"][data-active="true"]`)).toBeVisible()

    // Outside a workspace view This workspace has no list, so the switcher says why.
    await page.evaluate(() => window.__store!.getState().openSettingsPage())
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await expect(switcher(page)).toContainText('Switch Tab · All workspaces')
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('Go to a workspace to see its tabs')
    const outsideWorkspace = await readSwitcher(page)
    steps.push({ step: 'outside-workspace', ...outsideWorkspace })
    expect(outsideWorkspace.title).toBe('Switch Tab · This workspace')
    expect(outsideWorkspace.rows).toEqual([])
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-outside-workspace.png') })
    await page.keyboard.press('Escape')
    await expect(switcher(page)).toHaveCount(0)
    await page.keyboard.up('Control')
    // The toggle keeps the new scope even where it has no list to show.
    await page.evaluate(() => window.__store!.getState().closeSettingsPage())
    const keptScope = await peekSwitcher(page)
    steps.push({ step: 'kept-scope', ...keptScope })
    expect(keptScope.title).toBe('Switch Tab · This workspace')

    // After a failed save, the open box and the next Ctrl+Tab show the saved scope.
    await page.evaluate(() => {
      const store = window.__store!
      const save = store.getState().updateSettingsOrThrow
      const fail = new Promise<void>((_, reject) => window.addEventListener('e2e-fail', reject))
      store.setState({
        updateSettingsOrThrow: (next) => ('ctrlTabScope' in next ? fail : save(next))
      })
    })
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('Switch Tab · All workspaces')
    await page.evaluate(() => window.dispatchEvent(new Event('e2e-fail')))
    await expect(switcher(page)).toContainText('Switch Tab · This workspace')
    await page.keyboard.press('Escape')
    await page.keyboard.up('Control')
    expect((await peekSwitcher(page)).title).toBe('Switch Tab · This workspace')

    const reportPath = testInfo.outputPath('recent-tab-switcher-all-workspaces.json')
    writeFileSync(reportPath, `${JSON.stringify({ steps }, null, 2)}\n`)
    await testInfo.attach('switcher-states', { path: reportPath, contentType: 'application/json' })
  })

  test('from a focused browser page, Ctrl+A flips the scope and the release opens the tab', async ({
    orcaPage
  }, testInfo) => {
    const page = orcaPage
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    })
    const { primaryId, secondaryId } = await getWorktreeIdsByBranch(page)
    const activeTab = page.locator('[data-tab-id][data-active="true"]:visible')
    const steps: (SwitcherSnapshot & { step: string })[] = []
    const server = await startBrowserLinkServer()
    try {
      // Focus history: index.ts in e2e-secondary, then a page in the primary workspace.
      await openSeededFile(page, secondaryId, 'src/index.ts', { activate: true })
      await expect(activeTab).toContainText('index.ts')
      const browserTabId = await page.evaluate(
        ({ wId, url }) => {
          const state = window.__store!.getState()
          // Why: one task, so the primary terminal does not count as a visit and index.ts stays second.
          state.setActiveWorktree(wId)
          return state.createBrowserTab(wId, url, { title: 'Source page', activate: true }).id
        },
        { wId: primaryId, url: server.sourceUrl }
      )
      await expect
        .poll(() => readPageTitle(page, browserTabId), { timeout: 30_000 })
        .toBe('Source page')

      await sendKeysToPage(page, browserTabId, PAGE_CTRL_TAB)
      const workspaceScope = await readSwitcher(page)
      steps.push({ step: 'page-ctrl-tab', ...workspaceScope })
      expect(workspaceScope.title).toBe('Switch Tab · This workspace')
      await sendKeysToPage(page, browserTabId, [
        { type: 'keyDown', keyCode: 'A', modifiers: ['control'] }
      ])
      await expect(switcher(page)).toContainText('Switch Tab · All workspaces')
      const allScope = await readSwitcher(page)
      steps.push({ step: 'page-ctrl-a', ...allScope })
      expect(rowIndex(allScope, 'Source page')).toBe(0)
      expect(rowIndex(allScope, 'index.ts')).toBe(1)
      expect(allScope.rows[1].selected).toBe(true)
      expect(allScope.rows[1].text).toContain('e2e-secondary')
      await switcher(page).screenshot({
        path: testInfo.outputPath('switcher-from-browser-page.png')
      })

      // Why: A is the last key before the release, so a dropped Control keyup leaves the box open.
      await sendKeysToPage(page, browserTabId, [
        { type: 'keyUp', keyCode: 'A', modifiers: ['control'] },
        { type: 'keyUp', keyCode: 'Control' }
      ])
      await expect(switcher(page)).toHaveCount(0)
      await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
        'data-rendered-active-worktree-id',
        secondaryId
      )
      await expect(activeTab).toContainText('index.ts')
    } finally {
      await server.close()
    }

    const reportPath = testInfo.outputPath('recent-tab-switcher-browser-page.json')
    writeFileSync(reportPath, `${JSON.stringify({ steps }, null, 2)}\n`)
    await testInfo.attach('switcher-states-from-page', {
      path: reportPath,
      contentType: 'application/json'
    })
  })

  test('a long list keeps the selected row in view and scrolls with the wheel', async ({
    orcaPage
  }, testInfo) => {
    const page = orcaPage
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    })
    await page.evaluate((wId) => {
      const state = window.__store!.getState()
      for (let index = 1; index <= 15; index++) {
        state.createBrowserTab(wId, 'about:blank', { title: `Long list ${index}`, activate: false })
      }
    }, worktreeId)
    const measure = () =>
      switcher(page).evaluate((element) => {
        const list = element.children[1]
        if (!list) {
          throw new Error('the switcher has no row list')
        }
        const rows = [...list.querySelectorAll('[role="option"]')]
        const selected = rows.findIndex((row) => row.getAttribute('aria-selected') === 'true')
        const listBox = list.getBoundingClientRect()
        const rowBox = rows[selected]?.getBoundingClientRect()
        return {
          rows: rows.length,
          selected,
          inView:
            rowBox !== undefined &&
            rowBox.top >= listBox.top - 0.5 &&
            rowBox.bottom <= listBox.bottom + 0.5,
          scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight
        }
      })
    const steps: ({ step: string } & Awaited<ReturnType<typeof measure>>)[] = []
    const record = async (step: string): Promise<Awaited<ReturnType<typeof measure>>> => {
      const state = await measure()
      steps.push({ step, ...state })
      return state
    }

    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const opened = await record('open')
    // Why: the check means nothing unless the list is taller than the box.
    expect(opened.scrollHeight).toBeGreaterThan(opened.clientHeight)

    // Each Tab press keeps the selected row inside the box, down to the last row.
    for (let index = opened.selected; index < opened.rows - 1; index++) {
      await page.keyboard.press('Tab')
      expect(await measure()).toMatchObject({ selected: index + 1, inView: true })
    }
    await record('last row')
    await page.keyboard.press('Tab')
    const wrapped = await record('wrapped to the first row')
    expect(wrapped).toMatchObject({ selected: 0, inView: true })

    // The wheel scrolls the list and leaves the selection where it is.
    const listBox = await switcher(page).locator(':scope > div').nth(1).boundingBox()
    if (!listBox) {
      throw new Error('the switcher list is not on screen')
    }
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2)
    await page.mouse.wheel(0, 400)
    await expect.poll(async () => (await measure()).scrollTop).toBeGreaterThan(wrapped.scrollTop)
    expect((await record('wheel')).selected).toBe(0)
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-long-list.png') })
    await page.keyboard.press('Escape')
    await expect(switcher(page)).toHaveCount(0)
    await page.keyboard.up('Control')

    const reportPath = testInfo.outputPath('recent-tab-switcher-long-list.json')
    writeFileSync(reportPath, `${JSON.stringify({ steps }, null, 2)}\n`)
    await testInfo.attach('switcher-long-list', {
      path: reportPath,
      contentType: 'application/json'
    })
  })

  test('Tab strip order follows the sidebar rows and the panes of each workspace', async ({
    orcaPage
  }, testInfo) => {
    const page = orcaPage
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettings({
        uiLanguage: 'en',
        ctrlTabOrderMode: 'sequential',
        ctrlTabScope: 'all'
      })
    })
    const { primaryId, secondaryId } = await getWorktreeIdsByBranch(page)
    const activeTab = page.locator('[data-tab-id][data-active="true"]:visible')

    // e2e-secondary holds index.ts, then diff-note-layout.ts. Pinned, it leads the sidebar.
    await openSeededFile(page, secondaryId, 'src/index.ts', { activate: true })
    await expect(activeTab).toContainText('index.ts')
    await openSeededFile(page, secondaryId, 'src/diff-note-layout.ts')
    await expect(activeTab).toContainText('diff-note-layout.ts')
    await page.evaluate(async (wId) => {
      const result = await window.__store!.getState().updateWorktreeMeta(wId, { isPinned: true })
      if (!result?.ok) {
        throw new Error(`pin failed: ${JSON.stringify(result)}`)
      }
    }, secondaryId)

    // Terminal 1 moves to a new pane on the left of package.json, so the first pane on screen
    // is the second group that the workspace created.
    await switchToWorktree(page, primaryId)
    await openSeededFile(page, primaryId, 'package.json')
    await expect(activeTab).toContainText('package.json')
    const leftGroupId = await page.evaluate((wId) => {
      const state = window.__store!.getState()
      const terminalTab = (state.unifiedTabsByWorktree[wId] ?? []).find(
        (tab) => tab.contentType === 'terminal'
      )
      const groupId = terminalTab
        ? state.createEmptySplitGroup(wId, terminalTab.groupId, 'left')
        : null
      if (!terminalTab || !groupId) {
        throw new Error('the primary workspace did not split')
      }
      state.moveUnifiedTabToGroup(terminalTab.id, groupId)
      return groupId
    }, primaryId)

    await page.evaluate(
      (ids) => {
        const state = window.__store!.getState()
        state.setSidebarOpen(true)
        for (const id of ids) {
          state.revealWorktreeInSidebar(id)
        }
      },
      [primaryId, secondaryId]
    )
    const secondaryRow = await worktreeRowSurface(page, secondaryId).boundingBox()
    const primaryRow = await worktreeRowSurface(page, primaryId).boundingBox()
    if (!secondaryRow || !primaryRow) {
      throw new Error('the workspace rows are not on screen')
    }
    // Why: the check means nothing unless the sidebar order differs from the project order.
    expect(secondaryRow.y).toBeLessThan(primaryRow.y)
    await focusPane(page, primaryId, leftGroupId)

    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const strip = await readSwitcher(page)
    expect(strip.title).toBe('Switch Tab · All workspaces')
    expect(rowNames(strip)).toEqual([
      'index.ts',
      'diff-note-layout.ts',
      'Terminal 1',
      'package.json'
    ])
    // Terminal 1 is on screen and keeps its place, so Tab selects the tab after it.
    expect(strip.rows[3].selected).toBe(true)
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-tab-strip-order.png') })
    await page.keyboard.press('Escape')
    await expect(switcher(page)).toHaveCount(0)
    await page.keyboard.up('Control')

    const reportPath = testInfo.outputPath('recent-tab-switcher-tab-strip-order.json')
    writeFileSync(reportPath, `${JSON.stringify({ strip }, null, 2)}\n`)
    await testInfo.attach('switcher-tab-strip-order', {
      path: reportPath,
      contentType: 'application/json'
    })
  })

  test('Ctrl+A in the switcher does not reach a focused terminal', async ({
    orcaPage,
    electronApp
  }) => {
    const page = orcaPage
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    })
    await installTerminalPtyWriteSpy(electronApp)
    const ptyId = await waitForActivePanePtyId(page)
    const shellInput = async (): Promise<string> =>
      (await readTerminalPtyWriteEntries(electronApp))
        .filter((entry) => entry.id === ptyId)
        .map((entry) => entry.data)
        .join('')
    await focusActiveTerminalInput(page)
    await clearTerminalPtyWriteLog(electronApp)

    // Ctrl+A moves to the line start in readline and is a common tmux prefix; the switcher keeps it.
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('Switch Tab · All workspaces')
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('Switch Tab · This workspace')
    await page.keyboard.press('Escape')
    await expect(switcher(page)).toHaveCount(0)
    await page.keyboard.up('Control')

    // Why: the same chord without the switcher reaches the shell, so the log does see this focus.
    await page.keyboard.press('Control+a')
    await expect.poll(shellInput).toContain('\x01')
    expect((await shellInput()).split('\x01')).toHaveLength(2)
  })

  test('This workspace lists every pane, and both lists move the focus to the pane of the tab', async ({
    orcaPage
  }, testInfo) => {
    const page = orcaPage
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    })
    // index.ts stays in the first pane with Terminal 1; package.json is dropped on its right edge.
    await openSeededFile(page, worktreeId, 'src/index.ts')
    await openSeededFile(page, worktreeId, 'package.json')
    const panes = await page.evaluate((wId) => {
      const state = window.__store!.getState()
      const packageTab = (state.unifiedTabsByWorktree[wId] ?? []).find(
        (tab) => tab.contentType === 'editor' && tab.entityId.endsWith('package.json')
      )
      if (!packageTab) {
        throw new Error('package.json did not open')
      }
      const leftGroupId = packageTab.groupId
      state.dropUnifiedTab(packageTab.id, { groupId: leftGroupId, splitDirection: 'right' })
      const rightGroupId = window
        .__store!.getState()
        .unifiedTabsByWorktree[wId]?.find((tab) => tab.id === packageTab.id)?.groupId
      if (!rightGroupId || rightGroupId === leftGroupId) {
        throw new Error('the workspace did not split')
      }
      return { leftGroupId, rightGroupId }
    }, worktreeId)
    const paneEditor = (groupId: string) =>
      page.locator(`[data-tab-group-body-id="${groupId}"] .monaco-editor`).first()
    await expect(paneEditor(panes.leftGroupId)).toBeVisible()
    await expect(paneEditor(panes.rightGroupId)).toBeVisible()
    // Focus history: a click in the left pane (index.ts), then in the right pane (package.json).
    await paneEditor(panes.leftGroupId).click()
    await paneEditor(panes.rightGroupId).click()
    const focusedPane = () => readFocusedPane(page)
    await expect.poll(focusedPane).toBe(panes.rightGroupId)

    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const bothPanes = await readSwitcher(page)
    expect(bothPanes.title).toBe('Switch Tab · This workspace')
    expect(rowNames(bothPanes)).toEqual(['package.json', 'index.ts', 'Terminal 1'])
    expect(bothPanes.rows[1].selected).toBe(true)
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-two-panes.png') })
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)

    // The left pane shows index.ts and has the keyboard focus.
    await expect(
      page.locator(
        `[data-tab-group-strip-id="${panes.leftGroupId}"] [data-tab-id][data-active="true"]`
      )
    ).toContainText('index.ts')
    await expect.poll(focusedPane).toBe(panes.leftGroupId)

    // All workspaces opens rows through Cmd+J's path; the editor in the right pane must get the keys too.
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('Switch Tab · All workspaces')
    const allPanes = await readSwitcher(page)
    expect(rowNames(allPanes)).toEqual(['index.ts', 'package.json', 'Terminal 1'])
    expect(allPanes.rows[1].selected).toBe(true)
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect.poll(focusedPane).toBe(panes.rightGroupId)

    // From Settings, the row of the tab behind it gives the keys back to its editor, which stayed mounted.
    await page.evaluate(() => window.__store!.getState().openSettingsPage())
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await expect(switcher(page)).toContainText('Switch Tab · All workspaces')
    await page.keyboard.press('Shift+Tab')
    const behindSettings = await readSwitcher(page)
    expect(rowNames(behindSettings)[0]).toBe('package.json')
    expect(behindSettings.rows[0].selected).toBe(true)
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect.poll(focusedPane).toBe(panes.rightGroupId)

    // README.md goes behind package.json in one task, so the right pane has not loaded it, as after a
    // restart: its rich editor mounts only after the content loads, well after the release.
    await page.evaluate(
      ({ wId, rightGroupId }) => {
        const state = window.__store!.getState()
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === wId)
        if (!worktree) {
          throw new Error(`unknown worktree ${wId}`)
        }
        const separator = worktree.path.includes('\\') ? '\\' : '/'
        state.openFile(
          {
            filePath: `${worktree.path}${separator}README.md`,
            relativePath: 'README.md',
            worktreeId: wId,
            language: 'markdown',
            mode: 'edit'
          },
          { targetGroupId: rightGroupId }
        )
        const packageTab = (window.__store!.getState().unifiedTabsByWorktree[wId] ?? []).find(
          (tab) => tab.groupId === rightGroupId && tab.entityId.endsWith('package.json')
        )
        if (!packageTab) {
          throw new Error('package.json left the right pane')
        }
        window.__store!.getState().activateTab(packageTab.id, { worktreeId: wId })
      },
      { wId: worktreeId, rightGroupId: panes.rightGroupId }
    )
    await clickTab(page, 'Terminal 1')
    await focusActiveTerminalInput(page)
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('Switch Tab · This workspace')
    const markdownRow = rowIndex(await readSwitcher(page), 'README.md')
    expect(markdownRow).toBeGreaterThan(0)
    for (let row = 1; row < markdownRow; row++) {
      await page.keyboard.press('Tab')
    }
    const markdownPick = await readSwitcher(page)
    expect(markdownPick.rows[rowIndex(markdownPick, 'README.md')].selected).toBe(true)
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect.poll(focusedPane).toBe(panes.rightGroupId)
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.ProseMirror'))))
      .toBe(true)

    const reportPath = testInfo.outputPath('recent-tab-switcher-two-panes.json')
    writeFileSync(
      reportPath,
      `${JSON.stringify({ panes, bothPanes, allPanes, behindSettings, markdownPick }, null, 2)}\n`
    )
    await testInfo.attach('switcher-two-panes', {
      path: reportPath,
      contentType: 'application/json'
    })
  })
})
