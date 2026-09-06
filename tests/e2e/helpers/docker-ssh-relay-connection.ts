import { connectSshTestTarget } from './ssh-test-target-connection'
import type { Page } from '@stablyai/playwright-test'

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
  connectTimeoutMs?: number
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
      seedInitialTab: options.seedInitialTab,
      connectTimeoutMs: options.connectTimeoutMs
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
