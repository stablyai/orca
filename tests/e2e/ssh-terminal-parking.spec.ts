import type { TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady, getActiveTabId } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

// C1 slice A: SSH tabs park like local ones and reveal restores content from
// main's headless model (relay replay is the fallback). This is the SSH
// park+reveal round-trip fidelity check the design gate required.
test.describe('SSH terminal hidden view parking', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH parking uses POSIX SSH tooling.')

  test('parks a hidden SSH tab and restores its scrollback on reveal', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.setTimeout(240_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const sshPtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const sshTabId = await getActiveTabId(orcaPage)
      if (!sshTabId) {
        throw new Error('SSH terminal tab did not become active')
      }
      const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(snapshot.panes[0]?.ptyId).toBe(sshPtyId)

      // Why the ':' terminator: `${marker}_1:` must not substring-match _10/_100.
      const marker = `SSH_PARK_MARKER_${Date.now()}`
      await sendToTerminal(
        orcaPage,
        sshPtyId,
        `for i in $(seq 1 200); do echo "${marker}_$i:"; done\r`
      )
      await expect
        .poll(() => getTerminalContent(orcaPage, 20_000), {
          timeout: 30_000,
          message: 'SSH marker output did not render before parking'
        })
        .toContain(`${marker}_200:`)
      // Why the pad: ~3000 × ~60B ≈ 180KB pushes the early markers past the
      // relay's 100KiB rolling replay buffer while staying inside main's
      // ~5k-row headless model — so a revealed `${marker}_1:` can only have
      // come from the model paint, never the relay fallback.
      await sendToTerminal(
        orcaPage,
        sshPtyId,
        `for i in $(seq 1 3000); do echo "PAD_$i:0123456789012345678901234567890123456789"; done; echo "${marker}_PAD_DONE:"\r`
      )
      await expect
        .poll(() => getTerminalContent(orcaPage, 20_000), {
          timeout: 60_000,
          message: 'SSH pad output did not finish before parking'
        })
        .toContain(`${marker}_PAD_DONE:`)

      await parkHiddenTabBehindDecoy(orcaPage, remote.worktreeId, sshTabId, {
        parkDelayMs: PARKING_DELAY_MS
      })

      // Reveal: reattach must paint from main's headless model (or relay
      // replay when the model is unavailable) — never a blank pane.
      await orcaPage.evaluate((tabId) => {
        const state = window.__store?.getState()
        state?.setActiveTab(tabId)
        state?.setActiveTabType('terminal')
      }, sshTabId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await expect
        .poll(() => getTerminalContent(orcaPage, 20_000), {
          timeout: 60_000,
          message: 'revealed SSH tab did not restore the final pad line'
        })
        .toContain(`${marker}_PAD_DONE:`)
      // Depth proof: `${marker}_1:` predates >100KiB of later output, so its
      // presence after reveal proves the headless-model paint restored
      // scrollback the relay replay cannot hold.
      await expect
        .poll(() => getTerminalContent(orcaPage, 2_000_000), {
          timeout: 15_000,
          message: 'revealed SSH tab lost the pre-pad scrollback only the model paint restores'
        })
        .toContain(`${marker}_1:`)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
