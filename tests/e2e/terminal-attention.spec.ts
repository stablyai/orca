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
import { POST_REPLAY_MODE_RESET } from '../../src/renderer/src/components/terminal-pane/layout-serialization'
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
    state.setActiveTabType('terminal')
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
  // Why: the OSC title marker is a deterministic byte-stream fence. Once it
  // lands in the renderer, the preceding BEL has traversed the same PTY path.
  // printf is a shell builtin, so this still works in stripped CI PATHs.
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

async function getUnreadTerminalPaneKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    return Object.keys(store.getState().unreadTerminalPanes)
  })
}

async function getActivePaneKey(page: Page, tabId: string): Promise<string> {
  return page.evaluate((targetTabId) => {
    const manager = window.__paneManagers?.get(targetTabId)
    const pane = manager?.getActivePane?.()
    const leafId = pane?.leafId ?? null
    if (!leafId) {
      throw new Error(`No active pane leaf for terminal tab ${targetTabId}`)
    }
    return `${targetTabId}:${leafId}`
  }, tabId)
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
  // Why: pty-connection unit tests own raw BEL-byte detection. This E2E owns
  // the cross-component attention contract: background terminal attention
  // raises the tab indicator, and focusing the tab clears it.
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
      state.markWorktreeUnread(ownerWorktreeId)
      state.markTerminalTabUnread(tabId)
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

  // Why (show-until-interact): ghostty's model fires the bell even on the
  // currently-focused tab — the user only dismisses it by actually engaging
  // with the pane. This test proves the BEL on a focused tab is visible
  // until a pointerdown on the terminal container clears it.
  test('a BEL on the focused tab raises, then clears on click', async ({ orcaPage }) => {
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

    await emitBellAndWaitForTitleFlush(
      orcaPage,
      activePtyId,
      `focused-tab-bell-marker-${Date.now()}`
    )

    // The focused tab is now unread — the bell persists until the user
    // actually interacts with the pane.
    expect((await getUnreadTerminalTabIds(orcaPage)).includes(activeTabId)).toBe(true)
    const activeTabBell = orcaPage
      .locator(
        `[data-testid="sortable-tab"][data-tab-id="${activeTabId}"] [data-testid="tab-activity-bell"]`
      )
      .first()
    await expect(activeTabBell).toBeVisible()

    // A pointerdown inside the terminal container counts as interaction
    // (matches the pointerdown handler added in TerminalPane.tsx). Drive it
    // via the DOM so we exercise the real listener path rather than bypassing
    // to the store action.
    await orcaPage.evaluate((tabId) => {
      const managers = window.__paneManagers
      const manager = managers?.get(tabId)
      const pane = manager?.getActivePane()
      const container = pane?.container
      if (!container) {
        throw new Error('No active pane container to click')
      }
      container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    }, activeTabId)

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(activeTabId), {
        timeout: 5_000,
        message: 'Unread state did not clear after interacting with the pane'
      })
      .toBe(false)
    await expect(activeTabBell).toBeHidden()
  })

  // Why (plain Escape regression): Escape also emits real terminal input, but
  // the interrupt-intent branch returns early. It must still dismiss focused
  // terminal attention just like other user key input.
  test('a BEL on the focused tab raises, then clears on plain Escape', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const activeTabId = await getActiveTabId(orcaPage)
    if (!activeTabId) {
      throw new Error('Expected an active terminal tab')
    }
    const activePaneKey = await getActivePaneKey(orcaPage, activeTabId)
    const activePtyId = await waitForActivePanePtyId(orcaPage)
    await installRendererTitleLog(orcaPage)

    await emitBellAndWaitForTitleFlush(
      orcaPage,
      activePtyId,
      `focused-tab-escape-marker-${Date.now()}`
    )

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(activeTabId), {
        timeout: 10_000,
        message: 'Focused tab did not become unread after BEL'
      })
      .toBe(true)

    // Focused BEL owns the tab indicator; seed pane attention separately so the
    // Escape path proves it clears both store surfaces that pty-connection owns.
    await orcaPage.evaluate((paneKey) => {
      window.__store?.getState().markTerminalPaneUnread(paneKey)
    }, activePaneKey)
    await expect
      .poll(async () => (await getUnreadTerminalPaneKeys(orcaPage)).includes(activePaneKey), {
        timeout: 5_000,
        message: 'Seeded focused pane attention did not land'
      })
      .toBe(true)

    const activeTabBell = orcaPage
      .locator(
        `[data-testid="sortable-tab"][data-tab-id="${activeTabId}"] [data-testid="tab-activity-bell"]`
      )
      .first()
    await expect(activeTabBell).toBeVisible()

    await focusActiveXterm(orcaPage, activeTabId)
    await orcaPage.keyboard.press('Escape')

    await expect
      .poll(async () => (await getUnreadTerminalTabIds(orcaPage)).includes(activeTabId), {
        timeout: 5_000,
        message: 'Unread tab state did not clear after pressing Escape in xterm'
      })
      .toBe(false)
    await expect
      .poll(async () => (await getUnreadTerminalPaneKeys(orcaPage)).includes(activePaneKey), {
        timeout: 5_000,
        message: 'Unread pane state did not clear after pressing Escape in xterm'
      })
      .toBe(false)
    await expect(activeTabBell).toBeHidden()
  })

  // Why (restart regression guard): the original user-reported bug was that
  // after restarting Orca with a Claude Code session open, clicking between
  // panes on the restored tab produced undismissable bell indicators. Root
  // cause: xterm's SerializeAddon captures the TUI's mode-setting bytes
  // (e.g. `\e[?1004h` for focus reporting) in the scrollback snapshot, and
  // replaying that snapshot on restart re-enables focus reporting in xterm
  // even though the underlying shell is fresh. Pane clicks then emit
  // `\e[I` / `\e[O` into zsh, which rings the bell as unbound-key input.
  //
  // POST_REPLAY_MODE_RESET (in layout-serialization.ts) clears these mode
  // bits after every scrollback replay so the mode state matches the fresh
  // shell. This test pins that fix: after writing a DECSET 1004 byte into
  // the terminal, focus events should NOT be emitted back to the PTY.
  //
  // We drive xterm directly with the focus-enable escape (simulating what
  // the replay would do) and then simulate focus changes — without the
  // reset, xterm would dutifully emit focus escapes; with the reset, mode
  // 1004 is off and nothing leaks to the shell, so no BELs fire.
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

    // secondTabId is already active after createTerminalTab. Simulate what
    // scrollback replay does: a DECSET 1004 byte landing in xterm. Then
    // install an onData spy so we can observe everything xterm emits from
    // this point on — crucially, the focus escapes `\e[I` / `\e[O` that
    // leak when mode 1004 is still enabled. The POST_REPLAY_MODE_RESET
    // bundle should turn mode 1004 OFF; if it does, no focus escape is
    // emitted on the next blur and the spy's buffer stays empty.
    // Why: xterm's parser is async — bytes passed to `write()` are queued and
    // consumed on a later tick. During the brief window when mode 1004 is
    // enabled, xterm emits a synchronous focus-IN (`\e[I`) because the
    // terminal is focused; that emission MUST NOT land in the spy or the
    // assertion below will false-positive even when the post-replay reset
    // worked correctly.
    //
    // We use xterm's `write(data, callback)` overload: the callback fires
    // AFTER the parser has consumed that write. By installing the spy inside
    // the callback for the POST_REPLAY_MODE_RESET write, we guarantee any
    // transient focus escapes emitted while mode 1004 was briefly on have
    // already fired before the spy exists. No fixed sleep needed.
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
            // Parser has consumed both the DECSET and the reset. Any focus
            // escapes from the brief 1004-ON window have already been emitted
            // (and dropped on the floor, since nothing was listening). Install
            // the spy now to observe only post-reset output.
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

    // Why (try/finally): the onData spy + disposer live on window globals on
    // the shared renderer. If any assertion below throws, we still MUST tear
    // down the spy so it doesn't leak into subsequent tests (which would see
    // stale captured data and/or a dangling xterm onData subscription).
    try {
      // Trigger focus change away from secondTabId. If mode 1004 is still
      // enabled, xterm will emit `\e[O` via onData — captured by the spy above.
      // Also explicitly blur the xterm instance so the DOM focus actually moves
      // (setActiveTab alone doesn't blur focus).
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

      // Why: xterm does not reliably answer DA1 writes in hidden Electron
      // windows, but focus-reporting leaks are emitted as part of the focus
      // task itself. Let that task settle, then inspect the captured bytes.
      await orcaPage.waitForTimeout(100)

      // Mode 1004 reset succeeded iff no focus escapes are emitted — we assert
      // on the precise byte-level mechanism the fix guards against (`\e[I`
      // focus-in / `\e[O` focus-out), not tab unread state, because under the
      // show-until-interact model that state can be flipped by unrelated
      // shell-startup BELs.
      const emittedFromXterm = await orcaPage.evaluate(
        () =>
          (window as unknown as { __XTERM_ONDATA_SPY__: string[] | undefined })
            .__XTERM_ONDATA_SPY__ ?? []
      )
      // Join before matching: individual chunks could split an escape
      // across onData calls (unlikely but possible — e.g. if xterm
      // flushes mid-escape).
      // eslint-disable-next-line no-control-regex -- intentional terminal escape sequence matching
      expect(emittedFromXterm.join('')).not.toMatch(/\x1b\[[IO]/)
    } finally {
      // Dispose the onData subscription and clear the globals so nothing leaks
      // across tests on the shared renderer. Runs even if an assertion above
      // failed.
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
