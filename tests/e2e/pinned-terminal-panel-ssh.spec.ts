/**
 * E2E: pinned terminal panel on an SSH host — the panel's PTY must run on the
 * configured target, never fall back to the local machine (the exact
 * regression this covers: host resolution failing silently and every hosted
 * panel spawning locally).
 *
 * Requires a reachable SSH host; opt-in via ORCA_E2E_PANEL_SSH_HOST (config
 * alias resolvable by the runner's OpenSSH, BatchMode key auth). Skipped
 * otherwise so CI without mesh access stays green.
 */

import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getStoreState } from './helpers/store'

const SSH_HOST = process.env.ORCA_E2E_PANEL_SSH_HOST ?? ''

function remoteHostname(): string | null {
  try {
    return execFileSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_HOST, 'hostname'],
      {
        encoding: 'utf-8',
        timeout: 15_000
      }
    ).trim()
  } catch {
    return null
  }
}

test('pinned terminal panel runs its command on the configured SSH host', async ({ orcaPage }) => {
  test.skip(SSH_HOST.length === 0, 'ORCA_E2E_PANEL_SSH_HOST not set')
  const expectedHostname = remoteHostname()
  test.skip(expectedHostname === null, `ssh ${SSH_HOST} unreachable with BatchMode`)
  // Why: if both machines share a hostname the assertion cannot distinguish
  // remote from local-fallback — the test would pass vacuously.
  test.skip(expectedHostname === os.hostname(), 'remote hostname equals local hostname')
  test.setTimeout(180_000)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  // Register the SSH target through the real IPC surface (same path the
  // SSH-hosts settings UI uses), then point a panel at it by label.
  await orcaPage.evaluate(async (host) => {
    await window.api.ssh.addTarget({
      target: { label: host, configHost: host, host, port: 22, username: '' }
    })
    // Why: label hydration normally rides the targets-changed push; refresh
    // explicitly so the panel's host guard sees the new target immediately.
    const targets = await window.api.ssh.listTargets()
    window.__store?.getState().setSshTargetsMetadata(targets)
    window.__store?.getState().updateSettings({
      pinnedTerminalPanels: [{ id: 'e2e-ssh-panel', title: 'SSH Panel', command: 'hostname', host }]
    })
  }, SSH_HOST)

  await expect
    .poll(
      async () => orcaPage.evaluate(() => window.__store?.getState().sshTargetLabels.size ?? 0),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0)

  await expect
    .poll(
      async () =>
        getStoreState<{ id: string }[] | undefined>(orcaPage, 'settings.pinnedTerminalPanels').then(
          (panels) => panels?.length ?? 0
        ),
      { timeout: 10_000 }
    )
    .toBe(1)

  await orcaPage.getByRole('button', { name: 'SSH Panel' }).click()
  const panelHost = orcaPage.locator('[data-pinned-terminal-panel-id="e2e-ssh-panel"]')
  await expect(panelHost).toBeVisible({ timeout: 30_000 })
  await expect(panelHost.locator('.xterm')).toBeVisible({ timeout: 60_000 })
  // The one assertion that matters: the command's output is the REMOTE
  // hostname. A local fallback prints this machine's hostname instead.
  await expect(panelHost).toContainText(expectedHostname!, { timeout: 60_000 })
})
