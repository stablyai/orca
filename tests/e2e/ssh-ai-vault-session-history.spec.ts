import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerRemote } from './ssh-codex-reconnect-replay-driver'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedRemoteAiVaultHistory } from './ssh-ai-vault-session-history-fixtures'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

test.describe('SSH Agent Session History', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH tests use POSIX ssh tooling.')

  test('isolates SSH history and resumes host-owned Codex and Cursor sessions', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    const stamp = Date.now()
    const defaultSessionId = `remote-ai-vault-${stamp}`
    const runtimeSessionId = `remote-ai-vault-runtime-${stamp}`
    const claudeSessionId = `remote-ai-vault-claude-${stamp}`
    const cursorSessionId = randomUUID()
    const defaultTitle = `Remote AI Vault ${stamp}`
    const runtimeTitle = `Remote Runtime AI Vault ${stamp}`
    const claudeTitle = `Remote Claude AI Vault ${stamp}`
    const cursorTitle = `Remote Cursor AI Vault ${stamp}`

    try {
      target = startDockerSshRelayTarget(testInfo)
      seedRemoteAiVaultHistory(target, {
        defaultSessionId,
        runtimeSessionId,
        claudeSessionId,
        cursorSessionId,
        defaultTitle,
        runtimeTitle,
        claudeTitle,
        cursorTitle
      })

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerRemote(orcaPage, target)
      const sshScope = `ssh:${encodeURIComponent(remote.targetId)}`

      const scan = await orcaPage.evaluate(
        async ({
          sshScope,
          defaultTitle,
          runtimeTitle,
          claudeTitle,
          cursorTitle,
          workspacePath
        }) => {
          const local = await window.api.aiVault.listSessions({
            executionHostScope: 'local',
            force: true
          })
          const ssh = await window.api.aiVault.listSessions({
            executionHostScope: sshScope,
            force: true,
            scopePaths: [workspacePath]
          })
          const all = await window.api.aiVault.listSessions({
            executionHostScope: 'all',
            force: true
          })
          return {
            localHasRemote: local.sessions.some((session) => session.title === defaultTitle),
            localHasCursor: local.sessions.some((session) => session.title === cursorTitle),
            sshTitles: ssh.sessions.map((session) => session.title),
            allHasRuntime: all.sessions.some((session) => session.title === runtimeTitle),
            allHasClaude: all.sessions.some((session) => session.title === claudeTitle),
            remoteHostIds: ssh.sessions
              .filter((session) =>
                [defaultTitle, runtimeTitle, claudeTitle].includes(session.title)
              )
              .map((session) => session.executionHostId),
            remoteCommands: ssh.sessions
              .filter((session) => session.title === defaultTitle || session.title === runtimeTitle)
              .map((session) => session.resumeCommand),
            cursorSessions: ssh.sessions
              .filter((session) => session.title === cursorTitle)
              .map((session) => ({
                cwd: session.cwd,
                executionHostId: session.executionHostId,
                transcriptFilePath: session.transcriptFilePath
              })),
            allCursorHostIds: all.sessions
              .filter((session) => session.title === cursorTitle)
              .map((session) => session.executionHostId)
          }
        },
        {
          sshScope,
          defaultTitle,
          runtimeTitle,
          claudeTitle,
          cursorTitle,
          workspacePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
        }
      )
      expect(scan.localHasRemote).toBe(false)
      expect(scan.localHasCursor).toBe(false)
      expect(scan.sshTitles).toEqual(
        expect.arrayContaining([defaultTitle, runtimeTitle, claudeTitle])
      )
      expect(scan.allHasRuntime).toBe(true)
      expect(scan.allHasClaude).toBe(true)
      expect(new Set(scan.remoteHostIds)).toEqual(new Set([sshScope]))
      expect(scan.remoteCommands.join('\n')).toContain("CODEX_HOME='/root/.codex'")
      expect(scan.remoteCommands.join('\n')).toContain(
        "CODEX_HOME='/root/.local/share/orca/codex-runtime-home/home'"
      )
      expect(scan.cursorSessions).toEqual([
        {
          cwd: DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
          executionHostId: sshScope,
          transcriptFilePath: expect.stringContaining(`${cursorSessionId}.jsonl`)
        }
      ])
      expect(scan.allCursorHostIds).toEqual([sshScope])

      const inventory = await orcaPage.evaluate(
        (connectionId) => window.api.preflight.detectRemoteAgentInventory({ connectionId }),
        remote.targetId
      )
      expect(inventory).toMatchObject({
        version: 1,
        agents: expect.arrayContaining(['cursor']),
        matchedCommands: { cursor: 'cursor-agent' }
      })
      await orcaPage.evaluate(
        (connectionId) => window.__store?.getState().ensureRemoteDetectedAgents(connectionId),
        remote.targetId
      )

      const defaultSessionTitle = orcaPage.getByText(defaultTitle, { exact: true })
      const runtimeSessionTitle = orcaPage.getByText(runtimeTitle, { exact: true })
      const cursorSessionTitle = orcaPage.getByText(cursorTitle, { exact: true })

      await openAiVaultSidebar(orcaPage)
      await expect(defaultSessionTitle.first()).toBeVisible({ timeout: 30_000 })

      const hostButton = orcaPage.getByRole('button', { name: /Session History host:/ })
      await hostButton.click()
      await orcaPage.getByRole('menuitemradio', { name: /Local/ }).click()
      await expect(defaultSessionTitle).toHaveCount(0, { timeout: 30_000 })

      await hostButton.click()
      await orcaPage.getByRole('menuitemradio', { name: 'All hosts' }).click()
      await expect(runtimeSessionTitle.first()).toBeVisible({ timeout: 30_000 })

      await hostButton.click()
      await orcaPage
        .getByRole('menuitemradio')
        .filter({ hasNotText: /Local|All hosts/ })
        .click()
      await expect(defaultSessionTitle.first()).toBeVisible({ timeout: 30_000 })

      await installStartupQueueProbe(orcaPage)
      await defaultSessionTitle.first().click()
      await orcaPage.getByText('Resume in Worktree', { exact: true }).click()

      await expect
        .poll(() => readLastQueuedStartupCommand(orcaPage), { timeout: 30_000 })
        .toContain(`CODEX_HOME='/root/.codex' codex resume '${defaultSessionId}'`)
      const queuedWorktreeId = await readLastQueuedStartupWorktreeId(orcaPage)
      expect(queuedWorktreeId).toBe(remote.worktreeId)

      await cursorSessionTitle.first().click()
      await orcaPage.getByText('Resume in Worktree', { exact: true }).click()
      await expect
        .poll(() => readLastQueuedStartupCommand(orcaPage), { timeout: 30_000 })
        .toContain(
          `cd '${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}' && cursor-agent --resume '${cursorSessionId}'`
        )
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})

async function openAiVaultSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setRightSidebarOpen(true)
    store.getState().setRightSidebarTab('vault')
  })
}

async function installStartupQueueProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const holder = window as unknown as {
      __aiVaultQueuedStartups?: { tabId: string; startup: { command: string } }[]
    }
    holder.__aiVaultQueuedStartups = []
    const current = store.getState()
    const original = current.queueTabStartupCommand
    store.setState({
      queueTabStartupCommand: (tabId, startup) => {
        holder.__aiVaultQueuedStartups?.push({ tabId, startup: { command: startup.command } })
        original(tabId, startup)
      }
    })
  })
}

async function readLastQueuedStartupCommand(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const holder = window as unknown as {
      __aiVaultQueuedStartups?: { startup: { command: string } }[]
    }
    return holder.__aiVaultQueuedStartups?.at(-1)?.startup.command ?? null
  })
}

async function readLastQueuedStartupWorktreeId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const holder = window as unknown as {
      __aiVaultQueuedStartups?: { tabId: string }[]
    }
    const tabId = holder.__aiVaultQueuedStartups?.at(-1)?.tabId
    if (!tabId) {
      return null
    }
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
      if (tabs.some((tab) => tab.id === tabId)) {
        return worktreeId
      }
    }
    return null
  })
}
