import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

type ConnectedDockerRemote = {
  targetId: string
  repoId: string
  worktreeId: string
}

type RuntimeTerminalStatus = {
  isRunningAgent: boolean
  status: string | null
}

type RuntimeTerminalSummary = {
  handle: string
  ptyId: string | null
  title: string | null
}

async function connectDockerRemote(
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
            label: `Docker SSH Pi-Compatible Agent ${Date.now()}`,
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
          displayName: 'Docker SSH Pi-Compatible Agent'
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
    { target, remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
  )
}

async function emitOscTitle(page: Page, ptyId: string, title: string): Promise<void> {
  await sendToTerminal(page, ptyId, `printf '\\033]0;${title}\\007'\r`)
}

async function findTerminalByPtyId(page: Page, ptyId: string): Promise<string> {
  return page.evaluate(async (ptyId) => {
    const response = await window.api.runtime.call({
      method: 'terminal.list',
      params: { limit: 50 }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const terminals = (response.result as { terminals: RuntimeTerminalSummary[] }).terminals
    const terminal = terminals.find((candidate) => candidate.ptyId === ptyId)
    if (!terminal) {
      throw new Error(
        `No runtime terminal for PTY ${ptyId}; terminals=${JSON.stringify(terminals)}`
      )
    }
    return terminal.handle
  }, ptyId)
}

async function readTerminalAgentStatus(
  page: Page,
  terminalHandle: string
): Promise<RuntimeTerminalStatus> {
  return page.evaluate(async (terminal) => {
    const response = await window.api.runtime.call({
      method: 'terminal.agentStatus',
      params: { terminal }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return (response.result as { agentStatus: RuntimeTerminalStatus }).agentStatus
  }, terminalHandle)
}

test.describe('Docker SSH Pi-compatible agent titles', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH relay tests.')
  test.skip(process.platform === 'win32', 'Docker SSH relay tests use POSIX ssh tooling.')

  test('classifies OMP and Pi title transitions from a remote terminal', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerRemote(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const terminalHandle = await findTerminalByPtyId(orcaPage, ptyId)

      const marker = `PI_COMPATIBLE_TITLE_READY_${Date.now()}`
      await sendToTerminal(orcaPage, ptyId, `printf '${marker}\\n'\r`)
      await waitForTerminalOutput(orcaPage, marker, 20_000, 60_000)

      await emitOscTitle(orcaPage, ptyId, '\u280b OMP')
      await expect
        .poll(async () => readTerminalAgentStatus(orcaPage, terminalHandle), {
          timeout: 10_000,
          message: 'Remote OMP working title did not classify as an agent status'
        })
        .toMatchObject({ isRunningAgent: true, status: 'working' })

      await emitOscTitle(orcaPage, ptyId, 'OMP ready')
      await expect
        .poll(async () => readTerminalAgentStatus(orcaPage, terminalHandle), {
          timeout: 10_000,
          message: 'Remote OMP ready title did not classify as idle'
        })
        .toMatchObject({ isRunningAgent: true, status: 'idle' })

      await emitOscTitle(orcaPage, ptyId, '\u280b Pi')
      await expect
        .poll(async () => readTerminalAgentStatus(orcaPage, terminalHandle), {
          timeout: 10_000,
          message: 'Remote Pi working title did not classify as an agent status'
        })
        .toMatchObject({ isRunningAgent: true, status: 'working' })

      testInfo.annotations.push({
        type: 'docker-ssh-pi-compatible-title',
        description: `target=${remote.targetId} repo=${remote.repoId} worktree=${remote.worktreeId} pty=${ptyId} terminal=${terminalHandle}`
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
