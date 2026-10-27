import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { getRendererTitleLog, installRendererTitleLog } from './helpers/terminal-title-log'
import { POST_REPLAY_MODE_RESET } from '../../src/shared/terminal-mode-reset-profiles'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

test.describe.configure({ mode: 'serial' })

async function countRenderedTabs(page: Page): Promise<number> {
  return page.locator('[data-testid="sortable-tab"]').count()
}

async function createTerminalTab(page: Page): Promise<string> {
  const tabsBefore = await countRenderedTabs(page)
  const activeBefore = await getActiveTabId(page)

  await page.getByRole('button', { name: 'New tab' }).click()
  await page
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click()

  await expect
    .poll(() => countRenderedTabs(page), {
      timeout: 5_000,
      message: 'New Terminal did not render a new tab in the tab bar'
    })
    .toBe(tabsBefore + 1)

  let tabId: string | null = null
  await expect
    .poll(
      async () => {
        tabId = await getActiveTabId(page)
        return Boolean(tabId && tabId !== activeBefore)
      },
      {
        timeout: 5_000,
        message: 'New Terminal did not become the active tab'
      }
    )
    .toBe(true)

  if (!tabId) {
    throw new Error('createTerminalTab: active tab id was unavailable after creating terminal')
  }

  return tabId
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal', state.activeWorktreeId)
    state.setActiveTab(targetTabId)
  }, tabId)

  await expect
    .poll(async () => getActiveTabId(page), {
      timeout: 5_000,
      message: `Terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

async function emitBellAndWaitForTitleFlush(
  page: Page,
  ptyId: string,
  markerTitle: string
): Promise<void> {
  await waitForPtyShellEcho(page, ptyId, 30_000)
  // Use an OSC title as a byte-stream fence proving the prior BEL traversed the PTY; printf survives stripped PATH.
  await execInTerminal(page, ptyId, `printf '\\a\\033]0;${markerTitle}\\007'`)
  await expect
    .poll(async () => (await getRendererTitleLog(page)).includes(markerTitle), {
      timeout: 10_000,
      message: 'Marker title did not land — byte stream may not have been flushed'
    })
    .toBe(true)
}

async function getUnreadTerminalTabIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    return Object.keys(store.getState().unreadTerminalTabs)
  })
}

async function focusActiveXterm(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const manager = window.__paneManagers?.get(targetTabId)
    const pane = manager?.getActivePane?.()
    const textarea = pane?.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!pane || !textarea) {
      throw new Error(`No active xterm textarea for terminal tab ${targetTabId}`)
    }
    pane.terminal.focus()
    textarea.focus()
  }, tabId)

  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false
        ),
      {
        timeout: 5_000,
        message: 'xterm helper textarea did not receive keyboard focus'
      }
    )
    .toBe(true)
}

test.describe('Terminal attention', () => {
  // Units own BEL parsing; E2E pins background indicator raise and selection clear.
  test('background terminal attention marks a tab unread and clears on focus', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const firstTabId = await getActiveTabId(orcaPage)
    if (!firstTabId) {
      throw new Error('Expected an initial terminal tab')
    }

    const secondTabId = await createTerminalTab(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    // Focus the first tab so the second becomes a background tab; attention
    // arriving there should raise its indicator.
    await activateTerminalTab(orcaPage, firstTabId)
    await orcaPage.evaluate((tabId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const ownerWorktreeId =
        Object.entries(state.tabsByWorktree).find(([, tabs]) =>
          tabs.some((tab) => tab.id === tabId)
        )?.[0] ?? null
      if (!ownerWorktreeId) {
        throw new Error(`No owner worktree found for terminal tab ${tabId}`)
      }
      const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
      if (!leafId) {
        throw new Error(`No active leaf found for terminal tab ${tabId}`)
      }
      state.markTerminalBell({ worktreeId: ownerWorktreeId, tabId, paneKey: `${tabId}:${leafId}` })
    }, secondTabId)

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(secondTabId), {
        timeout: 10_000,
        message: 'Background tab did not become unread after BEL'
      })
      .toBe(true)

    const secondTabBell = orcaPage
      .locator(
        `[data-testid="sortable-tab"][data-tab-id="${secondTabId}"] [data-testid="tab-activity-bell"]`
      )
      .first()
    await expect(secondTabBell).toBeVisible()

    // Activating the tab counts as "the user saw it" — the indicator clears.
    await activateTerminalTab(orcaPage, secondTabId)

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(secondTabId), {
        timeout: 5_000,
        message: 'Unread state did not clear when the user focused the tab'
      })
      .toBe(false)
    await expect(secondTabBell).toBeHidden()
  })

  // Why (on screen means read, #28637): a BEL on the tab the present user is
  // looking at is already read, so it must leave no unread marker or bell.
  test('a BEL on the focused tab leaves no unread marker', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const activeTabId = await getActiveTabId(orcaPage)
    if (!activeTabId) {
      throw new Error('Expected an active terminal tab')
    }
    const activePtyId = await waitForActivePanePtyId(orcaPage)
    await installRendererTitleLog(orcaPage)

    // Why: presence comes only from trusted input; a bare Shift keydown sends nothing to the shell.
    await focusActiveXterm(orcaPage, activeTabId)
    await orcaPage.keyboard.press('Shift')

    await emitBellAndWaitForTitleFlush(
      orcaPage,
      activePtyId,
      `focused-tab-bell-marker-${Date.now()}`
    )

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(activeTabId), {
        timeout: 5_000,
        message: 'A BEL on the focused tab left it unread'
      })
      .toBe(false)
    await expect(
      orcaPage.locator(
        `[data-testid="sortable-tab"][data-tab-id="${activeTabId}"] [data-testid="tab-activity-bell"]`
      )
    ).toHaveCount(0)
  })

  // Replay can re-enable mode 1004 from an old TUI snapshot; fresh-shell focus then emits escape bytes and unbound-key BELs.
  // Require POST_REPLAY_MODE_RESET to prevent post-reset focus reporting.
  test('mode bits replayed into xterm do not leak focus escapes to the shell', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const firstTabId = await getActiveTabId(orcaPage)
    if (!firstTabId) {
      throw new Error('Expected an initial terminal tab')
    }

    const secondTabId = await createTerminalTab(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    // Queue DECSET 1004 then reset and install the onData spy only in the reset’s write callback.
    // xterm parses asynchronously and may emit transient focus-IN while 1004 is on; observing that would falsely fail a correct reset.
    await orcaPage.evaluate(
      ({ tabId, modeReset }) =>
        new Promise<void>((resolve, reject) => {
          const managers = window.__paneManagers
          const manager = managers?.get(tabId)
          const pane = manager?.getActivePane()
          if (!pane) {
            reject(new Error('No active pane on restored tab'))
            return
          }
          pane.terminal.write('\x1b[?1004h')
          pane.terminal.write(modeReset, () => {
            // Observe only output after both writes have parsed.
            const recorded: string[] = []
            ;(window as unknown as { __XTERM_ONDATA_SPY__: string[] }).__XTERM_ONDATA_SPY__ =
              recorded
            const disposer = pane.terminal.onData((data) => {
              recorded.push(data)
            })
            ;(
              window as unknown as { __XTERM_ONDATA_DISPOSE__?: () => void }
            ).__XTERM_ONDATA_DISPOSE__ = () => disposer.dispose()
            resolve()
          })
        }),
      { tabId: secondTabId, modeReset: POST_REPLAY_MODE_RESET }
    )

    // Dispose renderer-global spies in finally so failures cannot leak subscriptions into later tests.
    try {
      // Explicitly blur after tab selection; setActiveTab alone does not move DOM focus.
      await activateTerminalTab(orcaPage, firstTabId)
      await orcaPage.evaluate((tabId) => {
        const managers = window.__paneManagers
        const manager = managers?.get(tabId)
        const pane = manager?.getActivePane()
        if (!pane) {
          return
        }
        pane.terminal.blur()
      }, secondTabId)

      // Wait for the focus task; hidden-window DA1 responses are unreliable.
      await orcaPage.waitForTimeout(100)

      // Assert precise focus-in/out bytes rather than unread state that unrelated startup BELs can change.
      const emittedFromXterm = await orcaPage.evaluate(
        () =>
          (window as unknown as { __XTERM_ONDATA_SPY__: string[] | undefined })
            .__XTERM_ONDATA_SPY__ ?? []
      )
      // Join chunks before matching potentially split escape sequences.
      // eslint-disable-next-line no-control-regex -- intentional terminal escape sequence matching
      expect(emittedFromXterm.join('')).not.toMatch(/\x1b\[[IO]/)
    } finally {
      // Always remove the subscription and globals before the next shared-renderer test.
      await orcaPage.evaluate(() => {
        const w = window as unknown as {
          __XTERM_ONDATA_DISPOSE__?: () => void
          __XTERM_ONDATA_SPY__?: string[]
        }
        w.__XTERM_ONDATA_DISPOSE__?.()
        delete w.__XTERM_ONDATA_DISPOSE__
        delete w.__XTERM_ONDATA_SPY__
      })
    }
  })
})
