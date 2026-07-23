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
  relayGracePeriodSeconds?: number
  remotePath?: string
  viaProxyJump?: boolean
}

export async function connectDockerSshRelayTarget(
  page: Page,
  target: DockerSshRelayTarget,
  options: DockerSshRelayConnectionOptions = {}
): Promise<ConnectedDockerSshRelayTarget> {
  return page.evaluate(
    async ({ target, remotePath, relayGracePeriodSeconds, viaProxyJump }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const { target: createdTarget, repoReadoptions } = await window.api.ssh.addTarget({
          target: {
            label: `${viaProxyJump ? 'Docker SSH ProxyJump' : 'Docker SSH Relay'} E2E ${Date.now()}`,
            ...(viaProxyJump ? { configHost: 'orca-e2e-destination' } : {}),
            host: '127.0.0.1',
            port: viaProxyJump ? 22 : target.port,
            username: 'root',
            identityFile: target.identityFile,
            identitiesOnly: true,
            ...(viaProxyJump ? { jumpHost: 'orca-e2e-jump' } : {}),
            relayGracePeriodSeconds
          }
        })
        store.getState().recordSshRepoReadoptions(repoReadoptions)
        const state = await window.api.ssh.connect({ targetId: createdTarget.id })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(createdTarget.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(createdTarget.id, createdTarget.label)
        store.getState().setSshTargetLabels(labels)

        const result = await window.api.repos.addRemote({
          connectionId: createdTarget.id,
          remotePath,
          displayName: viaProxyJump ? 'Docker SSH ProxyJump E2E' : 'Docker SSH Relay E2E'
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(result.repo.id)
        const worktree = (store.getState().worktreesByRepo[result.repo.id] ?? [])[0]
        if (!worktree) {
          throw new Error(`No remote worktree found for ${result.repo.path}`)
        }
        store.getState().setActiveWorktree(worktree.id)
        if ((store.getState().tabsByWorktree[worktree.id] ?? []).length === 0) {
          store.getState().createTab(worktree.id)
        }
        store.getState().setActiveTabType('terminal')
        return {
          targetId: createdTarget.id,
          repoId: result.repo.id,
          worktreeId: worktree.id
        }
      } finally {
        credentialUnsub()
      }
    },
    {
      target,
      remotePath:
        options.remotePath ??
        (options.viaProxyJump
          ? DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH
          : DOCKER_SSH_RELAY_REMOTE_REPO_PATH),
      viaProxyJump: options.viaProxyJump ?? false,
      relayGracePeriodSeconds: options.relayGracePeriodSeconds ?? 1
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
