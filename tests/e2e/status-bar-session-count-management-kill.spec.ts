/**
 * E2E regression for #8372 — the status-bar CLI session count froze after a Manage Sessions kill.
 *
 * `pty:management:killOne` tears a session down with `adapter.shutdown()`. The daemon only fans
 * `exit` to the clients attached to that session, so when the killed session belongs to *another*
 * daemon client (a previous app generation, `orca serve`, a second Orca client) this window's main
 * process never emits `pty:exit`. The status-bar chip is an event-sourced cache: with no lifecycle
 * event and no interval it kept painting the pre-kill count until the Resource Manager popover was
 * opened — and opening the popover refreshes, which is exactly why this spec never opens it.
 *
 * The spec creates that foreign session the way the daemon protocol really does it: a second
 * DaemonClient connected to the app's own daemon socket. The app then sees three live sessions
 * (its two panes plus the foreign one), the third of which Manage Sessions lists as unbound.
 *
 * Visible evidence: the `>_ N` number in the status bar. It must go 3 -> 2 after the row kill,
 * with the popover closed the whole time.
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { DaemonClient } from '../../src/main/daemon/client'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

/** The closed status-bar chip. Its accessible name carries the same count it paints. */
function resourceChip(page: Page) {
  return page.getByRole('button', { name: /^Resource Manager, \d+ terminal session/ })
}

/** The count as the chip's accessible name reports it. */
async function readChipAriaCount(page: Page): Promise<number | null> {
  const label = await resourceChip(page).getAttribute('aria-label')
  const match = /(\d+) terminal session/.exec(label ?? '')
  return match ? Number(match[1]) : null
}

/** The count as a human reads it off the chip: the digits next to the terminal glyph. */
async function readChipVisibleCount(page: Page): Promise<string | null> {
  const text = await resourceChip(page).locator('span.tabular-nums').last().textContent()
  return text?.trim() ?? null
}

async function listDaemonSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await window.api.pty.listSessions()).map(({ id }) => id))
}

/** The daemon's session set has to hold the expected size across consecutive reads. */
async function waitForStableSessionIds(page: Page, expected: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const first = await listDaemonSessionIds(page)
        await page.waitForTimeout(750)
        const second = await listDaemonSessionIds(page)
        return (
          first.length === expected &&
          second.length === expected &&
          first.every((id) => second.includes(id))
        )
      },
      { timeout: 30_000, message: `The daemon session set never settled at ${expected}` }
    )
    .toBe(true)
}

test.describe('Status bar CLI session count', () => {
  test('drops after Manage Sessions kills a foreign daemon session, popover never opened', async ({
    orcaPage: page,
    electronApp
  }) => {
    test.skip(
      process.platform === 'win32',
      'Named-pipe daemon endpoints need a different socket path derivation.'
    )

    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)

    const hasPaneManager = await waitForActiveTerminalManager(page, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the TerminalPane manager.'
    )
    await waitForPaneCount(page, 1, 30_000)

    // A second daemon client, connected to the app's own daemon exactly as another Orca client
    // would be. Its session is live and listed, but this app never attaches to it.
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const runtimeDir = path.join(userDataDir, 'daemon')
    const foreignClient = new DaemonClient({
      socketPath: path.join(runtimeDir, `daemon-v${PROTOCOL_VERSION}.sock`),
      tokenPath: path.join(runtimeDir, `daemon-v${PROTOCOL_VERSION}.token`)
    })
    const foreignSessionId = `${randomUUID()}::${userDataDir}`

    try {
      await foreignClient.ensureConnected()
      const created = await foreignClient.request<{ isNew: boolean; pid: number }>(
        'createOrAttach',
        { sessionId: foreignSessionId, cols: 80, rows: 24, cwd: userDataDir, env: {} }
      )
      expect(created.isNew, 'the foreign daemon session was not created').toBe(true)

      // Split after the foreign session exists: the new pane's spawn event is the app's one
      // natural inventory re-read, so the chip starts out agreeing with the daemon.
      await splitActiveTerminalPane(page, 'vertical')
      await waitForPaneCount(page, 2, 30_000)

      // Both panes must be fully bound and settled before Settings unmounts the terminal view:
      // parking a still-spawning pane tears its PTY down, which would move the count for a
      // reason that has nothing to do with the kill under test.
      await waitForPaneIdentitySnapshot(page, 2)
      await waitForStableSessionIds(page, 3)

      const baselineIds = await listDaemonSessionIds(page)
      expect(baselineIds, 'the foreign session is not live on the daemon').toContain(
        foreignSessionId
      )
      const baseline = baselineIds.length
      expect(baseline, 'expected the two panes plus the foreign session').toBe(3)

      // Baseline: the chip must already agree with the daemon before the kill, otherwise a
      // post-kill mismatch would prove nothing about invalidation.
      await expect(resourceChip(page)).toBeVisible()
      await expect
        .poll(async () => readChipAriaCount(page), {
          timeout: 30_000,
          message: 'The status-bar chip never caught up with the live session count'
        })
        .toBe(baseline)
      expect(await readChipVisibleCount(page)).toMatch(new RegExp(`^${baseline}\\b`))

      // Real UI kill path: Settings > Terminal > Manage Sessions, row kill + confirm.
      await page.evaluate(() => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('store unavailable')
        }
        state.openSettingsTarget({ pane: 'terminal', repoId: null })
        state.openSettingsPage()
      })

      const killRowButton = page.getByRole('button', { name: `Kill session ${foreignSessionId}` })
      await expect(killRowButton).toBeVisible({ timeout: 30_000 })
      await killRowButton.click()

      const confirmButton = page.getByRole('button', { name: 'Kill session', exact: true })
      await expect(confirmButton).toBeVisible()
      await confirmButton.click()

      // The kill itself must succeed identically on both branches; only the chip differs.
      await expect
        .poll(async () => (await listDaemonSessionIds(page)).includes(foreignSessionId), {
          timeout: 30_000,
          message: 'The daemon never dropped the killed session'
        })
        .toBe(false)

      // Guard the whole point of the bug: the popover refreshes on open, so it must stay closed.
      await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0)

      // The regression: with no pty:exit and no invalidation the closed chip keeps the stale count.
      await expect
        .poll(async () => readChipAriaCount(page), {
          timeout: 15_000,
          message: `The status-bar chip stayed at the pre-kill count instead of dropping to ${baseline - 1}`
        })
        .toBe(baseline - 1)
      expect(
        await readChipVisibleCount(page),
        'The number painted on the chip did not follow its accessible name'
      ).toMatch(new RegExp(`^${baseline - 1}\\b`))

      await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0)
    } finally {
      await foreignClient
        .request('kill', { sessionId: foreignSessionId, immediate: true })
        .catch(() => {})
      foreignClient.disconnect()
    }
  })
})
