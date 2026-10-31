import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import type { Repo } from '../../../src/shared/repo-types'
import { toSshExecutionHostId } from '../../../src/shared/execution-host'
import { expect } from './orca-app'
import { seedRelayEraTarget } from './orcad-upgrade-profile'
import { attachRepoAndOpenTerminal, createRestartSession } from './orca-restart'
import { mutateStoppedProfileState } from './persisted-profile-state'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './store'

export type SeededSshWorkspaces = {
  targetId: string
  hostId: `ssh:${string}`
  repoId: string
  /** Each seeded workspace's id, by its name. */
  worktreeIds: Record<string, string>
}

// Seed a stopped profile with an unreachable SSH host so launch lists exactly its stored workspaces.
function seedUnreachableSshWorkspaces(
  userDataDir: string,
  input: { label: string; workspaces: { name: string; displayName: string }[] }
): SeededSshWorkspaces {
  const targetId = seedRelayEraTarget(userDataDir, {
    label: input.label,
    host: '127.0.0.1',
    port: 1,
    username: 'nobody'
  })
  const hostId = toSshExecutionHostId(targetId)
  const repoPath = '/srv/seeded-ssh-repo'
  const repo: Repo = {
    id: `repo-${targetId}`,
    path: repoPath,
    displayName: 'Remote project',
    badgeColor: '#737373',
    addedAt: Date.now(),
    connectionId: targetId
  }
  const worktreeIds = Object.fromEntries(
    input.workspaces.map(({ name }) => [name, `${repo.id}::${repoPath}/${name}`])
  )
  mutateStoppedProfileState(userDataDir, (state) => {
    state.repos = [...(Array.isArray(state.repos) ? state.repos : []), repo]
    state.worktreeMeta = {
      ...(state.worktreeMeta && typeof state.worktreeMeta === 'object' ? state.worktreeMeta : {}),
      ...Object.fromEntries(
        input.workspaces.map(({ name, displayName }) => [
          worktreeIds[name],
          { hostId, instanceId: `${name}-instance`, displayName }
        ])
      )
    }
  })
  return { targetId, hostId, repoId: repo.id, worktreeIds }
}

// Launch local and unreachable SSH workspaces from main’s stored state; dispose removes the app and profile.
export async function launchWithUnreachableSshWorkspaces(
  testInfo: TestInfo,
  localRepoPath: string,
  input: Parameters<typeof seedUnreachableSshWorkspaces>[1]
): Promise<{
  page: Page
  ssh: SeededSshWorkspaces
  /** The local test repo's primary workspace. */
  localWorktreeId: string
  dispose: () => Promise<void>
}> {
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | undefined
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const localWorktreeId = await attachRepoAndOpenTerminal(first.page, localRepoPath)
    await session.close(app)
    app = undefined
    const ssh = seedUnreachableSshWorkspaces(session.userDataDir, input)
    const launched = await session.launch()
    app = launched.app
    await waitForSessionReady(launched.page)
    await waitForStartupWorktreeRefresh(launched.page)
    const seededIds = Object.values(ssh.worktreeIds)
    await expect
      .poll(() =>
        launched.page.evaluate((ids) => {
          const listed = new Set(
            Object.values(window.__store!.getState().worktreesByRepo)
              .flat()
              .map((worktree) => worktree.id)
          )
          return ids.every((id) => listed.has(id))
        }, seededIds)
      )
      .toBe(true)
    const running = app
    return { page: launched.page, ssh, localWorktreeId, dispose: () => session.dispose(running) }
  } catch (error) {
    await session.dispose(app)
    throw error
  }
}
