// Throwaway interactive demo (untracked): a REAL docker sshd with
// `AllowTcpForwarding no` behind a real registered SSH workspace, so the whole
// per-host opt-out loop can be walked by hand:
//   forwarding-blocked card -> "Browse from this device instead" -> page loads
//   locally (Monitor icon in the URL bar) -> Settings lists the host with
//   "Route again" -> pressing it re-routes and the card returns.
// Run: ORCA_ROUTING_DEMO=1 ORCA_E2E_SSH_DOCKER=1 pnpm exec playwright test \
//   --config tests/playwright.config.ts --project electron-headless --workers=1 \
//   tests/e2e/ssh-routing-optout-demo.spec.ts
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  blockDockerSshRelayTargetTcpForwarding,
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

test.skip(process.env.ORCA_ROUTING_DEMO !== '1', 'Demo only; run with ORCA_ROUTING_DEMO=1')

const HOLD_MINUTES = 25

test('stages the per-host routing opt-out loop against a real forwarding-blocked sshd', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout((HOLD_MINUTES + 15) * 60_000)
  let target: DockerSshRelayTarget | null = null
  try {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
    })

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setSize(1440, 900)
      window?.center()
      window?.show()
      window?.focus()
    })

    target = startDockerSshRelayTarget(testInfo)
    // Real sshd policy: terminal healthy, browser forwarding refused with reason 1.
    blockDockerSshRelayTargetTcpForwarding(target)
    const remote = await connectDockerSshRelayTarget(orcaPage, target)

    await orcaPage.evaluate(
      ({ worktreeId }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Store unavailable')
        }
        state.createBrowserTab(worktreeId, 'https://example.com/', {
          title: 'Routing demo',
          activate: true
        })
      },
      { worktreeId: remote.worktreeId }
    )

    await expect(orcaPage.getByText('The SSH server blocks browser traffic')).toBeVisible({
      timeout: 180_000
    })

    console.log(
      `\n=== ROUTING DEMO READY — window stays up ${HOLD_MINUTES} minutes ===\n` +
        `The registered "Docker SSH Relay" host really refuses forwarding.\n` +
        `1. The browser tab shows the forwarding-blocked card.\n` +
        `2. Press "Browse from this device instead" -> example.com loads locally,\n` +
        `   URL bar shows the monitor icon ("Browsing from this device").\n` +
        `3. Settings -> Browser -> SSH workspaces lists the host with "Route again".\n` +
        `4. Press "Route again" -> routing resumes -> the card returns (host still blocks).\n`
    )
    await orcaPage.waitForTimeout(HOLD_MINUTES * 60_000)
  } finally {
    cleanupDockerSshRelayTarget(target)
  }
})
