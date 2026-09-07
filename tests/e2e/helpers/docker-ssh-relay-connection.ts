import { connectSshTestTarget } from './ssh-test-target-connection'
import { expect, type Page } from '@stablyai/playwright-test'

import {
  DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type ConnectedDockerSshRelayTarget = {
  targetId: string
  repoId: string
  worktreeId: string
}

type DockerSshRelayConnectionOptions = {
  relayGracePeriodSeconds?: number
  remotePath?: string
  viaProxyJump?: boolean
  /**
   * Seed a terminal tab when the worktree has none. Default true.
   *
   * Why it is optional: a spec asking whether the PRODUCT adds a tab cannot tell this helper's
   * tab from the one under test, so it must be able to leave the worktree empty.
   */
  seedInitialTab?: boolean
}

export async function connectDockerSshRelayTarget(
  page: Page,
  target: DockerSshRelayTarget,
  options: DockerSshRelayConnectionOptions = {}
): Promise<ConnectedDockerSshRelayTarget> {
  const viaProxyJump = options.viaProxyJump ?? false
  return connectSshTestTarget(
    page,
    {
      label: `${viaProxyJump ? 'Docker SSH ProxyJump' : 'Docker SSH Relay'} E2E ${Date.now()}`,
      ...(viaProxyJump ? { configHost: 'orca-e2e-destination' } : {}),
      host: target.host,
      port: viaProxyJump ? 22 : target.port,
      username: 'root',
      identityFile: target.identityFile,
      identitiesOnly: true,
      ...(viaProxyJump ? { jumpHost: 'orca-e2e-jump' } : {}),
      relayGracePeriodSeconds: options.relayGracePeriodSeconds ?? 1
    },
    {
      remotePath:
        options.remotePath ??
        (viaProxyJump ? DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH : DOCKER_SSH_RELAY_REMOTE_REPO_PATH),
      displayName: viaProxyJump ? 'Docker SSH ProxyJump E2E' : 'Docker SSH Relay E2E',
      seedInitialTab: options.seedInitialTab
    }
  )
}

export async function disconnectDockerSshRelayTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    await window.api.ssh.disconnect({ targetId })
  }, targetId)
}

export async function resetDockerSshRelayTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    await window.api.ssh.resetRelay({ targetId })
  }, targetId)
}

async function performDockerSshRelayReconnect(
  page: Page,
  targetId: string,
  disconnectFirst: boolean
): Promise<void> {
  await page.evaluate(
    async ({ targetId, disconnectFirst }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      if (disconnectFirst) {
        await window.api.ssh.disconnect({ targetId })
      }
      const state = await window.api.ssh.connect({ targetId })
      if (!state || state.status !== 'connected') {
        throw new Error(`SSH target did not reconnect: ${JSON.stringify(state)}`)
      }
      store.getState().setSshConnectionState(targetId, state)
    },
    { targetId, disconnectFirst }
  )
}

export async function reconnectDockerSshRelayTarget(page: Page, targetId: string): Promise<void> {
  return performDockerSshRelayReconnect(page, targetId, true)
}

export async function reconnectDisconnectedDockerSshRelayTarget(
  page: Page,
  targetId: string
): Promise<void> {
  return performDockerSshRelayReconnect(page, targetId, false)
}

export async function recoverDockerSshRelayAfterFault(
  page: Page,
  targetId: string,
  injectFault: () => void | Promise<void>
): Promise<void> {
  const readAuthority = () =>
    page.evaluate((id) => window.__store?.getState().sshConnectionStates.get(id), targetId)
  const before = await readAuthority()
  expect(before).toMatchObject({
    status: 'connected',
    providerEpoch: expect.any(String),
    connectionGeneration: expect.any(Number)
  })
  await injectFault()
  // The pre-fault connected publication can remain visible until the next IPC event.
  await expect
    .poll(
      async () => {
        const after = await readAuthority()
        return (
          after?.status === 'connected' &&
          (after.providerEpoch !== before?.providerEpoch ||
            after.connectionGeneration !== before?.connectionGeneration)
        )
      },
      { timeout: 120_000, message: 'SSH authority did not recover after the injected fault' }
    )
    .toBe(true)
}
