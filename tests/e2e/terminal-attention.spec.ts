import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  discoverActivePtyId,
  execInTerminal,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { POST_REPLAY_MODE_RESET } from '../../src/renderer/src/components/terminal-pane/layout-serialization'

test.describe.configure({ mode: 'serial' })

async function createTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('createTerminalTab: window.__store is unavailable')
    }

    const state = store.getState()
    const newTab = state.createTab(targetWorktreeId)
    state.setActiveTabType('terminal')
    return newTab.id
  }, worktreeId)

  await expect
    .poll(async () => getActiveTabId(page), {
      timeout: 5_000,
      message: `Terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)

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

async function emitBell(page: Page, ptyId: string): Promise<void> {
  await execInTerminal(page, ptyId, `node -e "process.stdout.write('\\u0007')"`)
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

test.describe('Terminal attention', () => {
  // Why: BEL on a background tab raises the tab-level bell and the
  // worktree-level dot. Focusing the tab clears the flag — the bell
  // auto-clears on focus/keystroke. This is the core attention contract.
  test('a BEL marks a background tab unread and clears on focus', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const firstTabId = await getActiveTabId(orcaPage)
    if (!firstTabId) {
      throw new Error('Expected an initial terminal tab')
    }

    const secondTabId = await createTerminalTab(orcaPage, worktreeId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const secondTabPtyId = await discoverActivePtyId(orcaPage)

    // Focus the first tab so the second becomes a background tab; a BEL
    // arriving there should raise its indicator.
    await activateTerminalTab(orcaPage, firstTabId)
    await emitBell(orcaPage, secondTabPtyId)

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

  // Why (visibility guard): markTerminalTabUnread skips the currently-active
  // tab. A BEL arriving on the tab the user is already looking at must not
  // leave a persistent indicator — there is nothing to "notify" about.
  test('a BEL on the focused tab does not raise its own bell', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const activeTabId = await getActiveTabId(orcaPage)
    if (!activeTabId) {
      throw new Error('Expected an active terminal tab')
    }
    const activePtyId = await discoverActivePtyId(orcaPage)

    // Emit the BEL, then a deterministic OSC title marker. When the marker
    // title lands, all prior PTY bytes (including the BEL) have been
    // processed — we can then safely assert that the focused tab is not
    // unread. This avoids the flaky fixed-timeout pattern.
    await emitBell(orcaPage, activePtyId)
    const MARKER_TITLE = 'focused-tab-bell-marker'
    await execInTerminal(
      orcaPage,
      activePtyId,
      `node -e "process.stdout.write('\\u001b]0;${MARKER_TITLE}\\u0007')"`
    )

    await expect
      .poll(
        async () =>
          orcaPage.evaluate((want) => {
            const store = window.__store
            if (!store) {
              return false
            }
            return Object.values(store.getState().tabsByWorktree ?? {})
              .flat()
              .some((tab) => tab.title === want)
          }, MARKER_TITLE),
        {
          timeout: 10_000,
          message: 'Marker title did not land — byte stream may not have been flushed'
        }
      )
      .toBe(true)

    expect((await getUnreadTerminalTabIds(orcaPage)).includes(activeTabId)).toBe(false)
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
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const firstTabId = await getActiveTabId(orcaPage)
    if (!firstTabId) {
      throw new Error('Expected an initial terminal tab')
    }

    const secondTabId = await createTerminalTab(orcaPage, worktreeId)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    // secondTabId is already active after createTerminalTab. Simulate what
    // scrollback replay does: a DECSET 1004 byte landing in xterm. This is
    // the exact byte Claude Code emits at startup, and the exact byte
    // SerializeAddon captures in a post-restart scrollback dump. The
    // post-replay reset in layout-serialization.ts should cancel it out —
    // so this write, immediately followed by the reset, produces a terminal
    // with mode 1004 off. We write while secondTabId has focus so the
    // DECSET lands on the tab whose xterm we want to verify.
    await orcaPage.evaluate(
      ({ tabId, modeReset }) => {
        const managers = window.__paneManagers
        const manager = managers?.get(tabId)
        const pane = manager?.getActivePane()
        if (!pane) {
          throw new Error('No active pane on restored tab')
        }
        // Enable focus reporting and then immediately apply the same reset
        // the real scrollback-restore path applies. After this, mode 1004
        // should be OFF.
        pane.terminal.write('\x1b[?1004h')
        pane.terminal.write(modeReset)
      },
      { tabId: secondTabId, modeReset: POST_REPLAY_MODE_RESET }
    )

    // Now trigger a focus change. The DECSET happened while secondTabId was
    // active; the subsequent focus change to firstTabId causes a focus-out
    // on secondTabId's xterm. If POST_REPLAY_MODE_RESET failed to disable
    // mode 1004, xterm would emit `\e[O` down secondTabId's PTY and zsh
    // would ring the bell. Flush pending output with a marker OSC title
    // and assert that no unread indicator appeared.
    await activateTerminalTab(orcaPage, firstTabId)

    // Resolve secondTabId's PTY directly from the store. We can't use
    // discoverActivePtyId here — firstTabId is the active tab now, so that
    // helper would return the wrong PTY and the marker flush would not
    // guarantee secondTabId's pending output has been drained.
    // Why: waitForActiveTerminalManager only waits for the pane manager to
    // have panes — it does NOT wait for updateTabPtyId to fire, which
    // happens asynchronously after pty.spawn resolves in pty-connection.ts.
    // Poll so we don't race the spawn callback on slow CI.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate((targetTabId) => {
            const store = window.__store
            if (!store) {
              return null
            }
            return store.getState().ptyIdsByTabId[targetTabId]?.[0] ?? null
          }, secondTabId),
        {
          timeout: 10_000,
          message: `No PTY registered for tab ${secondTabId}`
        }
      )
      .not.toBeNull()

    const secondTabPtyId = await orcaPage.evaluate((targetTabId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const pty = store.getState().ptyIdsByTabId[targetTabId]?.[0]
      if (!pty) {
        throw new Error(`No PTY found for tab ${targetTabId}`)
      }
      return pty
    }, secondTabId)
    const MARKER_TITLE = 'mode-reset-marker'
    await execInTerminal(
      orcaPage,
      secondTabPtyId,
      `node -e "process.stdout.write('\\u001b]0;${MARKER_TITLE}\\u0007')"`
    )

    await expect
      .poll(
        async () =>
          orcaPage.evaluate((want) => {
            const store = window.__store
            if (!store) {
              return false
            }
            return Object.values(store.getState().tabsByWorktree ?? {})
              .flat()
              .some((tab) => tab.title === want)
          }, MARKER_TITLE),
        {
          timeout: 10_000,
          message: 'Marker title did not land — byte stream may not have been flushed'
        }
      )
      .toBe(true)

    // By the time the marker arrives, any BEL that mode 1004 would have
    // produced has also been processed. The tab should not be unread.
    expect((await getUnreadTerminalTabIds(orcaPage)).includes(secondTabId)).toBe(false)
    const secondTabBell = orcaPage
      .locator(
        `[data-testid="sortable-tab"][data-tab-id="${secondTabId}"] [data-testid="tab-activity-bell"]`
      )
      .first()
    await expect(secondTabBell).toBeHidden()
  })
})
