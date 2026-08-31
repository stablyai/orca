// Throwaway interactive preview (untracked): a REAL routed SSH-workspace page
// (docker sshd) with the egress indicator chip visible, held open for review.
// Run: ORCA_SSH_INDICATOR_PREVIEW=1 ORCA_E2E_SSH_DOCKER=1 pnpm exec playwright test \
//   --config tests/playwright.config.ts --project electron-headless --workers=1 \
//   tests/e2e/ssh-egress-indicator-preview.spec.ts
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  startSshRemoteOnlyBrowserFixture,
  SSH_REMOTE_ONLY_ORIGIN
} from './helpers/ssh-remote-only-browser-fixture'

test.skip(
  process.env.ORCA_SSH_INDICATOR_PREVIEW !== '1',
  'Preview only; run with ORCA_SSH_INDICATOR_PREVIEW=1 (requires Docker)'
)

const HOLD_MINUTES = 20

test('shows the egress indicator on a live routed SSH page and holds', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout((HOLD_MINUTES + 15) * 60_000)
  let target: DockerSshRelayTarget | null = null
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setSize(1440, 900)
      window?.center()
      window?.show()
      window?.focus()
    })

    target = startDockerSshRelayTarget(testInfo)
    startSshRemoteOnlyBrowserFixture(target)
    const remote = await connectDockerSshRelayTarget(orcaPage, target)

    await orcaPage.evaluate(
      ({ worktreeId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('store unavailable')
        }
        state.setActiveWorktree(worktreeId)
        state.createBrowserTab(worktreeId, url, { title: 'Routed preview', activate: true })
      },
      { worktreeId: remote.worktreeId, url: `${SSH_REMOTE_ONLY_ORIGIN}/login` }
    )

    const chip = orcaPage.getByTestId('ssh-egress-indicator')
    await expect(chip).toBeVisible({ timeout: 60_000 })
    await expect(chip).toHaveAttribute('data-egress', 'ssh')

    console.log(
      `\n=== EGRESS INDICATOR PREVIEW READY — window stays up ${HOLD_MINUTES} minutes ===`
    )
    console.log('The toolbar chip shows the SSH host; hover for the tooltip, click to jump to the')
    console.log('routing setting. The page itself is served from INSIDE the container — the render')
    console.log('is live proof of SSH egress. Try "Browse from this device instead" flows too.\n')
    await new Promise((resolve) => setTimeout(resolve, HOLD_MINUTES * 60_000))
  } finally {
    if (target) {
      cleanupDockerSshRelayTarget(target)
    }
  }
})
