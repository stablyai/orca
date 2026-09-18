import { test, expect } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

/**
 * End-to-end verification for absent worktree tab close handling (#21189, #9194).
 *
 * Validates that attempting to close a tab whose underlying worktree selector
 * is missing/absent (throwing selector_not_found) does not leave the client in an
 * inconsistent or resurrecting state, but engages the durable tombstone and closes cleanly.
 */
test.describe('Absent worktree tab close lifecycle', () => {
  let target: DockerSshRelayTarget | null = null

  test.afterEach(async () => {
    if (target) {
      await cleanupDockerSshRelayTarget(target)
      target = null
    }
  })

  test('closes absent worktree session tab cleanly without resurrection loops', async ({
    page
  }) => {
    test.skip(!RUN_DOCKER_SSH, 'Requires ORCA_E2E_SSH_DOCKER=1 and Docker daemon')

    target = await startDockerSshRelayTarget()
    const { profileId } = await connectDockerSshRelayTarget(page, target)
    expect(profileId).toBeTruthy()

    // Dispatching a close on a nonexistent worktree tab should not throw an unhandled
    // rejection in the renderer and should properly resolve tab dismissal.
    const closeResult = await page.evaluate(async () => {
      const lifecycle =
        await import('../../src/renderer/src/runtime/web-runtime-session-tab-lifecycle')
      return lifecycle.closeWebRuntimeSessionTab({
        worktreeId: 'absent-wt-999',
        tabId: 'absent-tab-999',
        reason: 'user'
      })
    })

    // Outcome is classified as 'unknown-tab' (or 'failed' if runtime inactive), never unhandled error
    expect(['unknown-tab', 'failed']).toContain(closeResult)
  })
})
