/** A server-hosted browser page in an SSH workspace loads that host's localhost, not the server's (STA-13126). */
import { RuntimeClient } from '../../src/cli/runtime/client'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  startDockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import {
  SSH_REMOTE_ONLY_PORT,
  startSshRemoteOnlyBrowserFixture
} from './helpers/ssh-remote-only-browser-fixture'
import { ORCAD_TEMPLATE, skipUnlessManagedDockerHost } from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

// Only the SSH host listens here; the server loading its own loopback would find nothing.
const HOST_LOCALHOST_URL = `http://127.0.0.1:${SSH_REMOTE_ONLY_PORT}/`

test('a server-hosted page in an SSH workspace loads the SSH host’s localhost', async (// oxlint-disable-next-line no-empty-pattern -- Owns its host and server.
{}, testInfo) => {
  // Boots a headless server that deploys its own managed server onto the SSH host.
  test.setTimeout(6 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const host = await launchHeadlessPairedRuntimeHost({
    extraEnv: { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE! }
  })
  try {
    startSshRemoteOnlyBrowserFixture(target)
    const cli = new RuntimeClient(host.userDataDir, 120_000)
    const added = await cli.call<{ target: { id: string } }>('ssh.addTarget', {
      target: {
        label: `serve browser localhost ${Date.now()}`,
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true
      }
    })
    const targetId = added.result.target.id
    await cli.call('ssh.connect', { targetId })
    const repo = await cli.call<{ repo: { id: string } }>('repo.addRemote', {
      connectionId: targetId,
      remotePath: DOCKER_SSH_HOST_REMOTE_REPO_PATH
    })
    let worktreeId: string | undefined
    await expect
      .poll(
        async () => {
          const listed = await cli.call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${repo.result.repo.id}`
          })
          worktreeId = listed.result.worktrees[0]?.id
          return worktreeId ?? null
        },
        { timeout: 2 * 60_000 }
      )
      .not.toBeNull()
    const worktree = `id:${worktreeId}`

    const created = await cli.call<{ browserPageId: string }>('browser.tabCreate', {
      worktree,
      url: HOST_LOCALHOST_URL
    })
    const page = created.result.browserPageId
    await expect
      .poll(
        async () => {
          const evaluated = await cli
            .call<{ result: unknown }>('browser.eval', {
              worktree,
              page,
              expression: 'document.querySelector("#marker")?.textContent ?? null'
            })
            .catch(() => null)
          return evaluated?.result.result ?? null
        },
        { timeout: 60_000 }
      )
      .toBe('cookie:none')
  } finally {
    await host.dispose()
    cleanupDockerSshHostTarget(target)
  }
})
