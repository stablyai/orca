// Resource counts stay unknown until Resources is opened; Manage Sessions must not invent an observation.

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
  return page.getByRole('button', { name: /^Resource Manager, / })
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
  test('keeps an unobserved count unknown after Manage Sessions kills a foreign daemon session', async ({
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

    // Create through a second daemon connection so this app lists the foreign session without attaching.
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

      // Keep two attached panes alive alongside the foreign session throughout the kill.
      await splitActiveTerminalPane(page, 'vertical')
      await waitForPaneCount(page, 2, 30_000)

      // Wait for both panes to bind before Settings unmounts; killing a still-spawning pane would change counts independently.
      await waitForPaneIdentitySnapshot(page, 2)
      await waitForStableSessionIds(page, 3)

      const baselineIds = await listDaemonSessionIds(page)
      expect(baselineIds, 'the foreign session is not live on the daemon').toContain(
        foreignSessionId
      )
      const baseline = baselineIds.length
      expect(baseline, 'expected the two panes plus the foreign session').toBe(3)

      await expect(resourceChip(page)).toHaveAccessibleName(
        'Resource Manager, terminal count unavailable'
      )
      await expect(resourceChip(page)).toHaveAttribute('aria-expanded', 'false')

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

      await expect
        .poll(async () => (await listDaemonSessionIds(page)).includes(foreignSessionId), {
          timeout: 30_000,
          message: 'The daemon never dropped the killed session'
        })
        .toBe(false)

      await waitForStableSessionIds(page, baseline - 1)
      await expect(resourceChip(page)).toHaveAccessibleName(
        'Resource Manager, terminal count unavailable'
      )
      await expect(resourceChip(page)).toHaveAttribute('aria-expanded', 'false')
    } finally {
      await foreignClient
        .request('kill', { sessionId: foreignSessionId, immediate: true })
        .catch(() => {})
      foreignClient.disconnect()
    }
  })
})
