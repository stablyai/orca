import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import {
  startDockerSshRelayTarget,
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { assertInteractiveTerminal } from './helpers/nested-runtime-ssh-client-route'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'

test.skip(process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs owned Docker SSH host')

test('paired desktop Files downloads from SSH owned by its server', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const fileName = 'NESTED_DOWNLOAD_OWNER.txt'
  const filePath = path.posix.join(DOCKER_SSH_RELAY_REMOTE_REPO_PATH, fileName)
  const destination = path.join(testRepoPath, 'nested-download-result.txt')
  const marker = 'ACTUAL_NESTED_SSH_DOWNLOAD_OWNER'
  const hub = createRestartSession(testInfo)
  let target: DockerSshRelayTarget | null = null
  let launch: Awaited<ReturnType<typeof hub.launch>> | null = null
  let client: PairedElectronClient | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    execDockerSshRelayTargetCommand(target, `printf '%s' '${marker}' > '${filePath}'`)
    launch = await hub.launch()
    await waitForSessionReady(launch.page)
    const connected = await connectDockerSshRelayTarget(launch.page, target)
    const offer = await createRuntimeDesktopPairingOffer(launch.page)
    client = await launchPairedElectronClient(offer, testInfo, 'Owned nested download server')
    await client.page.emulateMedia({ reducedMotion: 'reduce' })
    const route = await assertInteractiveTerminal(client, connected.repoId, 'NESTED_DOWNLOAD_READY')
    expect(route.runtimeOwnerEnvironmentId).toBe(client.environmentId)
    expect(route.localSshTargetIds).not.toContain(connected.targetId)
    const independent = await client.page.evaluate(
      async ({ environmentId, worktreeId }) => {
        return window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.read',
          params: { worktree: `id:${worktreeId}`, relativePath: 'NESTED_DOWNLOAD_OWNER.txt' }
        })
      },
      { environmentId: client.environmentId, worktreeId: route.worktreeId }
    )
    console.log('[actual-nested-host-read]', independent)
    expect(JSON.stringify(independent)).toContain(marker)
    await client.app.evaluate(({ dialog }, destination) => {
      Object.defineProperty(dialog, 'showSaveDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePath: destination })
      })
    }, destination)
    await dismissTransientAnnouncement(client.page)
    await client.page.evaluate(() => {
      const state = window.__store!.getState()
      state.setRightSidebarTab('explorer')
      state.setRightSidebarOpen(true)
    })
    const row = client.page.locator('[data-file-explorer-row]').filter({ hasText: fileName })
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })
    await client.page.getByRole('menuitem', { name: 'Download', exact: true }).click()
    await expect
      .poll(async () => {
        return (
          existsSync(destination) ||
          (await client!.page.locator('[data-sonner-toast][data-type="error"]').count()) > 0
        )
      })
      .toBe(true)
    console.log(
      '[actual-nested-download-notices]',
      await client.page.locator('[data-sonner-toast]').allTextContents()
    )
    console.log('[actual-nested-download-path-exists]', existsSync(destination))
    const after = await client.page.evaluate(
      async ({ environmentId, worktreeId, targetId }) => {
        const read = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.read',
          params: { worktree: `id:${worktreeId}`, relativePath: 'NESTED_DOWNLOAD_OWNER.txt' }
        })
        const state = window.__store!.getState()
        return {
          read,
          connectionStatus: state.sshStateByEnvironment
            .get(environmentId)
            ?.connectionStates.get(targetId)?.status,
          desktopTargets: (await window.api.ssh.listTargets()).map((target) => target.id)
        }
      },
      {
        environmentId: client.environmentId,
        worktreeId: route.worktreeId,
        targetId: connected.targetId
      }
    )
    console.log('[independent-nested-after-download]', after)
    expect(JSON.stringify(after.read)).toContain(marker)
    expect(after.connectionStatus).toBe('connected')
    expect(after.desktopTargets).not.toContain(connected.targetId)
    const toast = client.page.locator('[data-sonner-toast]').last()
    await expect(toast).toHaveAttribute('data-mounted', 'true')
    await expect(toast).toHaveCSS('opacity', '1')
    await client.page.screenshot({ path: testInfo.outputPath('nested-download-owner.png') })
    expect(existsSync(destination)).toBe(true)
    expect(readFileSync(destination, 'utf8')).toBe(marker)
    expect(await client.getDirectSshAttemptTargetIds()).toEqual([])
  } finally {
    await client?.dispose()
    if (launch) {
      await hub.close(launch.app)
    }
    await hub.dispose()
    if (target) {
      cleanupDockerSshRelayTarget(target)
    }
    rmSync(destination, { force: true })
  }
})
