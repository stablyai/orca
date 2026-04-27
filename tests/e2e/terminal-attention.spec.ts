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
  // Why: `tput bel` is the canonical way to emit BEL from the shell — this is
  // the exact command the user will run to reproduce the attention path. Prefer
  // it over `node -e` so the test exercises the same PTY byte stream a real
  // user sees.
  await execInTerminal(page, ptyId, `tput bel`)
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
    const activePtyId = await discoverActivePtyId(orcaPage)

    // Emit the BEL, then a deterministic OSC title marker. When the marker
    // title lands, all prior PTY bytes (including the BEL) have been
    // processed — we can then safely assert unread state without racing the
    // async PTY pipeline.
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

      // Why: flush xterm's output queue with a DA1 query — xterm replies via
      // onData with `\e[?...c`. By the time the reply lands in the spy, any
      // focus escape the blur handler would have emitted has also landed.
      // This gives us a deterministic "all-prior-output-processed" signal
      // without a fixed sleep (which expect.poll + .not.toMatch does NOT
      // provide — expect.poll exits as soon as the assertion passes once,
      // so .not.toMatch on an empty buffer would pass instantly at 0ms).
      await orcaPage.evaluate((tabId) => {
        const managers = window.__paneManagers
        const manager = managers?.get(tabId)
        const pane = manager?.getActivePane()
        if (!pane) {
          throw new Error('No active pane on restored tab')
        }
        pane.terminal.write('\x1b[c')
      }, secondTabId)

      await expect
        .poll(
          async () => {
            const emitted = await orcaPage.evaluate(
              () =>
                (window as unknown as { __XTERM_ONDATA_SPY__: string[] | undefined })
                  .__XTERM_ONDATA_SPY__ ?? []
            )
            return emitted.join('')
          },
          {
            timeout: 5_000,
            message: 'DA1 reply never arrived — xterm onData spy did not receive data'
          }
        )
        // eslint-disable-next-line no-control-regex -- intentional terminal escape sequence matching
        .toMatch(/\x1b\[\?.*c/)

      // By this point all prior xterm output has been observed. Read the
      // final buffer once and assert no focus escape is present. Mode 1004
      // reset succeeded iff no focus escapes are emitted — we assert on the
      // precise byte-level mechanism the fix guards against (`\e[I` focus-in
      // / `\e[O` focus-out), not the tab unread state, because under the
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
