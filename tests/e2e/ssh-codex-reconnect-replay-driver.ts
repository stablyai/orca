import { execFileSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import {
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'

export type ConnectedDockerRemote = {
  targetId: string
  worktreeId: string
}

export function dropDockerSshClientSessions(target: DockerSshRelayTarget): void {
  execFileSync(
    'docker',
    [
      'exec',
      target.containerName,
      'bash',
      '-lc',
      `ps -eo pid=,comm=,args= | awk '$2 == "sshd" && index($0, "sshd: root") { print $1 }' | xargs -r kill -9`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
  )
}

export async function connectDockerRemote(
  page: Page,
  target: DockerSshRelayTarget
): Promise<ConnectedDockerRemote> {
  return await page.evaluate(
    async ({ target, remotePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const createdTarget = await window.api.ssh.addTarget({
          target: {
            label: `Docker SSH Codex Artifact Repro ${Date.now()}`,
            host: '127.0.0.1',
            port: target.port,
            username: 'root',
            identityFile: target.identityFile,
            identitiesOnly: true,
            relayGracePeriodSeconds: 1
          }
        })
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
          displayName: 'Docker SSH Codex Artifact Repro'
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
        return { targetId: createdTarget.id, worktreeId: worktree.id }
      } finally {
        credentialUnsub()
      }
    },
    { target, remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
  )
}

export async function switchToNonRemoteWorktree(
  page: Page,
  remoteWorktreeId: string
): Promise<string> {
  const otherWorktreeId = await page.evaluate((remoteWorktreeId) => {
    const store = window.__store
    if (!store) {
      return null
    }
    const state = store.getState()
    const other = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id !== remoteWorktreeId)
    if (!other) {
      return null
    }
    state.setActiveWorktree(other.id)
    return other.id
  }, remoteWorktreeId)
  if (!otherWorktreeId) {
    throw new Error('No non-remote worktree available to hide the SSH terminal')
  }
  return otherWorktreeId
}

export async function installPtyReplayProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = window.api?.pty
    if (!api || typeof api.onReplay !== 'function') {
      throw new Error('PTY replay API unavailable')
    }
    const holder = window as unknown as {
      __orcaSshCodexReplayProbe?: {
        payloads: { id: string; length: number; preview: string }[]
        dispose: () => void
      }
    }
    holder.__orcaSshCodexReplayProbe?.dispose()
    const payloads: { id: string; length: number; preview: string }[] = []
    const dispose = api.onReplay(({ id, data }) => {
      payloads.push({
        id,
        length: data.length,
        preview: data.slice(-400)
      })
    })
    holder.__orcaSshCodexReplayProbe = { payloads, dispose }
  })
}

export async function waitForDockerRemoteReconnected(page: Page, targetId: string): Promise<void> {
  let observedNonConnected = false
  await expect
    .poll(
      async () => {
        const status = await page.evaluate((targetId) => {
          const state = window.__store?.getState().sshConnectionStates.get(targetId)
          return state?.status ?? null
        }, targetId)
        if (status !== 'connected') {
          observedNonConnected = true
        }
        return observedNonConnected && status === 'connected'
      },
      {
        timeout: 90_000,
        message: 'Docker SSH target did not auto-reconnect after transport drop'
      }
    )
    .toBe(true)
}

export async function readReplayProbeSnapshot(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __orcaSshCodexReplayProbe?: {
          payloads: { id: string; length: number; preview: string }[]
        }
      }
    ).__orcaSshCodexReplayProbe
    return {
      replayCount: probe?.payloads.length ?? 0,
      replayPayloads: probe?.payloads.slice(-8) ?? []
    }
  })
}

export async function readDuplicateStatusRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const text = pane?.serializeAddon?.serialize?.() ?? ''
    const counts = new Map<string, number>()
    const escapeSequencePattern = new RegExp(
      `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
      'g'
    )
    for (const line of text.split(/\r?\n/)) {
      const normalized = line.replace(escapeSequencePattern, '').trim()
      if (!/gpt-5\.5|background terminal|\/ps to view|\/stop to close/i.test(normalized)) {
        continue
      }
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
    }
    return Array.from(counts)
      .filter(([, count]) => count > 1)
      .map(([line, count]) => `${count}x ${line}`)
      .slice(0, 12)
  })
}

export async function enableRiskyTerminalRendererPath(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store unavailable')
    }
    const state = store.getState()
    store.setState({
      settings: {
        ...state.settings!,
        terminalGpuAcceleration: 'on',
        theme: 'dark'
      }
    })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    manager?.setTerminalGpuAcceleration('on')
  })
}
