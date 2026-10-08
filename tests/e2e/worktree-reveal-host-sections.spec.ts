import { expect, test } from './helpers/orca-app'
import {
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'

const sections = [
  { groupBy: 'none', key: 'pinned', label: 'Pinned', pinned: true },
  { groupBy: 'none', key: 'all', label: 'All', pinned: false },
  {
    groupBy: 'workspace-status',
    key: 'workspace-status:in-progress',
    label: 'In progress',
    pinned: false
  },
  { groupBy: 'pr-status', key: 'pr:in-progress', label: 'In progress', pinned: false }
] as const

for (const section of sections) {
  for (const hostId of ['ssh:reveal-builder', 'runtime:reveal-builder'] as const) {
    for (const collapsedHost of [false, true]) {
      test(`reveals ${hostId} ${section.key} workspace without expanding local section (host collapsed: ${collapsedHost})`, async ({
        orcaPage
      }, testInfo) => {
        await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
        await waitForSessionReady(orcaPage)
        await waitForActiveWorktree(orcaPage)
        await waitForStartupWorktreeRefresh(orcaPage)
        const ids = await orcaPage.evaluate(
          async ({ hostId, collapsedHost, section }) => {
            const store = window.__store!
            const state = store.getState()
            const sourceRepo = state.repos[0]
            const sourceWorktree = state.worktreesByRepo[sourceRepo.id][0]
            await state.updateWorktreeMeta(sourceWorktree.id, {
              isPinned: section.pinned,
              displayName: 'Local workspace'
            })
            const local = {
              ...sourceWorktree,
              hostId: 'local' as const,
              isPinned: section.pinned,
              displayName: 'Local workspace'
            }
            const remoteRepo = {
              ...sourceRepo,
              id: 'reveal-remote-repo',
              executionHostId: hostId,
              connectionId: hostId.startsWith('ssh:') ? 'reveal-builder' : null,
              displayName: 'Remote project'
            }
            const remote = {
              ...sourceWorktree,
              id: 'reveal-remote-workspace',
              repoId: remoteRepo.id,
              hostId,
              isPinned: section.pinned,
              isMainWorktree: false,
              displayName: 'Remote workspace'
            }
            state.setActiveView('terminal')
            state.setSidebarOpen(true)
            await window.api.ui.set({ groupBy: section.groupBy })
            state.setShowSleepingWorkspaces(true)
            state.setHideDefaultBranchWorkspace(false)
            state.setFilterRepoIds([])
            const collapsedGroups = [
              section.key,
              `${section.key}:host:${hostId}`,
              ...(collapsedHost ? [`host:${hostId}`] : [])
            ]
            await window.api.ui.set({ collapsedGroups })
            store.setState({
              groupBy: section.groupBy,
              repos: [sourceRepo, remoteRepo],
              worktreesByRepo: { [sourceRepo.id]: [local], [remoteRepo.id]: [remote] },
              sshTargetLabels: new Map([['reveal-builder', 'Remote builder']]),
              sshConnectionStates: new Map([
                [
                  'reveal-builder',
                  {
                    targetId: 'reveal-builder',
                    status: 'connected',
                    error: null,
                    reconnectAttempt: 0
                  }
                ]
              ]),
              visibleWorkspaceHostIds: ['local', hostId],
              workspaceHostScope: 'all',
              activeRepoId: remoteRepo.id,
              activeWorktreeId: remote.id,
              activeWorkspaceKey: `worktree:${remote.id}`,
              activeWorkspaceExecutionHostId: hostId,
              pendingRevealWorktree: null,
              collapsedGroups: new Set(collapsedGroups)
            })
            return { local: local.id, remote: remote.id }
          },
          { hostId, collapsedHost, section }
        )
        const headers = orcaPage.getByRole('button', { name: new RegExp(`^${section.label}`) })
        const localRow = orcaPage.locator(
          `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.local)}]`
        )
        const remoteRow = orcaPage.locator(
          `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.remote)}]`
        )
        if (section.pinned || section.groupBy === 'workspace-status') {
          await expect(headers.first()).toHaveAttribute('aria-expanded', 'false')
        }
        await expect(localRow).toHaveCount(0)
        await expect(remoteRow).toHaveCount(0)
        await orcaPage.screenshot({
          path: testInfo.outputPath('before-reveal.png'),
          clip: { x: 0, y: 170, width: 280, height: 500 }
        })
        await orcaPage.getByRole('button', { name: 'Reveal active workspace' }).click()
        await expect(remoteRow).toBeVisible()
        await expect(remoteRow).toHaveAttribute('data-scroll-reveal-highlight', 'true')
        await orcaPage.screenshot({
          path: testInfo.outputPath('after-reveal.png'),
          clip: { x: 0, y: 170, width: 280, height: 500 }
        })
        await expect(headers).toHaveCount(2)
        if (section.pinned || section.groupBy === 'workspace-status') {
          await expect(headers.first()).toHaveAttribute('aria-expanded', 'false')
        }
        if (section.pinned || section.groupBy === 'workspace-status') {
          await expect(headers.last()).toHaveAttribute('aria-expanded', 'true')
        }
        await expect(localRow).toHaveCount(0)

        await headers.last().click()
        await expect(remoteRow).toHaveCount(0)
        await orcaPage.evaluate((localId) => {
          const store = window.__store!
          const local = Object.values(store.getState().worktreesByRepo)
            .flat()
            .find((worktree) => worktree.id === localId)!
          store.setState({
            activeRepoId: local.repoId,
            activeWorktreeId: localId,
            activeWorkspaceKey: `worktree:${localId}`,
            activeWorkspaceExecutionHostId: 'local',
            pendingRevealWorktree: null
          })
        }, ids.local)
        await orcaPage.getByRole('button', { name: 'Reveal active workspace' }).click()
        await expect(localRow).toBeVisible()
        if (section.pinned || section.groupBy === 'workspace-status') {
          await expect(headers.first()).toHaveAttribute('aria-expanded', 'true')
          await expect(headers.last()).toHaveAttribute('aria-expanded', 'false')
        }
        await expect(remoteRow).toHaveCount(0)
      })
    }
  }
}
