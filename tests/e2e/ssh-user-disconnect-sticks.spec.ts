import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

// Longer than the pane's deferred connect (~0.4 s after mount) and its 250 ms fallback timer,
// which is what used to redial the host right after the user's Disconnect.
const HOLD_MS = 6_000

type PublishedSshState = {
  status: string | null
  connectionGeneration: number | null
  disconnectedBy: string | null
}

async function readPublishedSshState(page: Page, targetId: string): Promise<PublishedSshState> {
  return page.evaluate(async (targetId) => {
    const state = await window.api.ssh.getState({ targetId })
    return {
      status: state?.status ?? null,
      connectionGeneration: state?.connectionGeneration ?? null,
      disconnectedBy: state?.disconnectedBy ?? null
    }
  }, targetId)
}

/**
 * The user's own Disconnect holds until the user connects again. Before, a terminal pane open on
 * the host redialed it within half a second, because nothing stored what the user asked for:
 * "disconnected" only meant there was no connection object, so the pane's connect looked like
 * any other. A network drop still reconnects on its own; that is covered by the transport-drop
 * specs, and this one only proves a Disconnect is not undone behind the user's back.
 */
test.describe("SSH user's Disconnect sticks", () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the dockerized SSH relay tests')

  test("keeps the host down with a terminal open, until the overlay's Connect", async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      // Why: the overlay is asserted by its user-visible English text.
      await orcaPage.evaluate(async () => {
        await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
      })
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await expect
        .poll(() => readPublishedSshState(orcaPage, remote.targetId), {
          timeout: 30_000,
          message: "the host never published the user's Disconnect"
        })
        .toMatchObject({ status: 'disconnected', disconnectedBy: 'user' })
      const heldDown = await readPublishedSshState(orcaPage, remote.targetId)

      // Sampled, not slept on: a redial that lands and drops again between two reads still moves
      // the generation, which is the evidence this checks for.
      const deadline = Date.now() + HOLD_MS
      while (Date.now() < deadline) {
        expect(await readPublishedSshState(orcaPage, remote.targetId)).toEqual(heldDown)
        await orcaPage.waitForTimeout(250)
      }

      const overlay = orcaPage.locator('[data-ssh-disconnected-by-user="true"]').first()
      await expect(overlay).toBeVisible({ timeout: 30_000 })
      await expect(overlay.getByText(/You disconnected /)).toBeVisible()
      await overlay.getByRole('button', { name: 'Connect' }).click()

      await expect
        .poll(() => readPublishedSshState(orcaPage, remote.targetId), {
          timeout: 120_000,
          message: "the overlay's Connect never connected the host"
        })
        .toMatchObject({ status: 'connected', disconnectedBy: null })
      const reconnected = await readPublishedSshState(orcaPage, remote.targetId)
      expect(reconnected.connectionGeneration).toBeGreaterThan(heldDown.connectionGeneration ?? 0)
      await waitForActivePanePtyId(orcaPage, 60_000)
      await expect(orcaPage.locator('[data-ssh-disconnected-by-user="true"]')).toHaveCount(0)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
