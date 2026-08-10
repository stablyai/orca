import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type { WorkspaceSessionState } from '../../src/shared/types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { createRestartSession } from './helpers/orca-restart'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

type PersistedSessionData = {
  workspaceSession: WorkspaceSessionState
  workspaceSessionsByHostId?: Record<string, WorkspaceSessionState>
}

function projectSessionForWorktree(
  session: WorkspaceSessionState,
  worktreeId: string
): WorkspaceSessionState {
  const source = getDefaultWorkspaceSession()
  const tabs = session.tabsByWorktree[worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  source.tabsByWorktree = { [worktreeId]: tabs }
  source.terminalLayoutsByTabId = Object.fromEntries(
    Object.entries(session.terminalLayoutsByTabId).filter(([tabId]) => tabIds.has(tabId))
  )
  source.activeTabIdByWorktree = {
    [worktreeId]: session.activeTabIdByWorktree?.[worktreeId] ?? null
  }
  source.lastVisitedAtByWorktreeId = {
    [worktreeId]: session.lastVisitedAtByWorktreeId?.[worktreeId] ?? 0
  }
  source.defaultTerminalTabsAppliedByWorktreeId = {
    [worktreeId]: session.defaultTerminalTabsAppliedByWorktreeId?.[worktreeId] ?? false
  }
  if (session.remoteSessionIdsByTabId) {
    source.remoteSessionIdsByTabId = Object.fromEntries(
      Object.entries(session.remoteSessionIdsByTabId).filter(([tabId]) => tabIds.has(tabId))
    )
  }
  return source
}

function strandSessionInSshPartition(
  userDataDir: string,
  hostId: `ssh:${string}`,
  worktreeId: string,
  session: WorkspaceSessionState
): void {
  const dataPath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as PersistedSessionData
  const source = projectSessionForWorktree(session, worktreeId)
  const tabIds = new Set(source.tabsByWorktree[worktreeId].map((tab) => tab.id))
  data.workspaceSession.tabsByWorktree[worktreeId] = []
  for (const tabId of tabIds) {
    delete data.workspaceSession.terminalLayoutsByTabId[tabId]
    delete data.workspaceSession.remoteSessionIdsByTabId?.[tabId]
  }
  delete data.workspaceSession.activeTabIdByWorktree?.[worktreeId]
  delete data.workspaceSession.lastVisitedAtByWorktreeId?.[worktreeId]
  delete data.workspaceSession.defaultTerminalTabsAppliedByWorktreeId?.[worktreeId]
  data.workspaceSessionsByHostId = {
    ...data.workspaceSessionsByHostId,
    [hostId]: source
  }
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`)
}

async function readTabIdentity(
  page: Page,
  worktreeId: string
): Promise<{ id: string; ptyId: string | null }> {
  return page.evaluate((id) => {
    const tab = window.__store?.getState().tabsByWorktree[id]?.[0]
    if (!tab) {
      throw new Error(`No tab restored for ${id}`)
    }
    return { id: tab.id, ptyId: tab.ptyId }
  }, worktreeId)
}

test.describe('SSH session partition adoption', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH adoption uses POSIX SSH tooling.')

  test('round-trips stranded tabs without remote deletion @headful', async (// oxlint-disable-next-line no-empty-pattern -- The test owns each Electron launch.
  {}, testInfo) => {
    test.setTimeout(360_000)
    const restart = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let app: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const first = await restart.launch()
      app = first.app
      await waitForSessionReady(first.page)
      const remote = await connectDockerSshRelayTarget(first.page, target)
      await expect.poll(() => waitForActiveWorktree(first.page)).toBe(remote.worktreeId)
      await waitForActiveTerminalManager(first.page, 60_000)
      const ptyId = await waitForActivePanePtyId(first.page, 60_000)
      const identity = await readTabIdentity(first.page, remote.worktreeId)
      expect(identity.ptyId).toBe(ptyId)

      const token = `SSH_PARTITION_${Date.now()}`
      const proofPath = `/tmp/orca-ssh-partition-${Date.now()}`
      await focusActiveTerminalInput(first.page)
      await first.page.keyboard.type(
        `export ORCA_PARTITION_TOKEN=${token}; printf '%s' "$ORCA_PARTITION_TOKEN" > ${proofPath}`
      )
      await first.page.keyboard.press('Enter')
      await expect
        .poll(() => execDockerSshRelayTargetCommand(target!, `cat ${proofPath}`))
        .toBe(token)

      const persisted = await first.page.evaluate(() => window.api.session.get())
      await restart.close(first.app)
      app = null
      const hostId = `ssh:${encodeURIComponent(remote.targetId)}` as const
      strandSessionInSshPartition(restart.userDataDir, hostId, remote.worktreeId, persisted)

      const second = await restart.launch()
      app = second.app
      await waitForSessionReady(second.page, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(second.page), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(second.page, 60_000)
      expect(await readTabIdentity(second.page, remote.worktreeId)).toEqual(identity)
      expect(await second.page.evaluate((id) => window.api.session.get(id), hostId)).toMatchObject({
        tabsByWorktree: {}
      })
      expect(
        await second.page.evaluate(
          async ({ targetId, worktreePath }) => {
            const snapshot = await window.api.remoteWorkspace.get({ targetId })
            return snapshot?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? []
          },
          { targetId: remote.targetId, worktreePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
        )
      ).toContain(identity.id)
      await waitForActivePanePtyId(second.page, 60_000)
      await focusActiveTerminalInput(second.page)
      await second.page.keyboard.type(`printf '%s' "$ORCA_PARTITION_TOKEN" > ${proofPath}.restored`)
      await second.page.keyboard.press('Enter')
      await expect
        .poll(() => execDockerSshRelayTargetCommand(target!, `cat ${proofPath}.restored`))
        .toBe(token)

      await restart.close(second.app)
      app = null
      const third = await restart.launch()
      app = third.app
      await waitForSessionReady(third.page, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(third.page), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      expect(await readTabIdentity(third.page, remote.worktreeId)).toEqual(identity)
      expect(await third.page.evaluate((id) => window.api.session.get(id), hostId)).toMatchObject({
        tabsByWorktree: {}
      })
    } finally {
      if (app) {
        await restart.close(app)
      }
      await restart.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
