import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

for (const hostId of ['ssh:reveal-builder', 'runtime:reveal-builder'] as const) {
  for (const collapsedHost of [false, true]) {
    test(`reveals ${hostId} pinned workspace without expanding local pins (host collapsed: ${collapsedHost})`, async ({
      orcaPage
    }, testInfo) => {
      await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const ids = await orcaPage.evaluate(
        async ({ hostId, collapsedHost }) => {
          const store = window.__store!
          const state = store.getState()
          const sourceRepo = state.repos[0]
          const sourceWorktree = state.worktreesByRepo[sourceRepo.id][0]
          await state.updateWorktreeMeta(sourceWorktree.id, {
            isPinned: true,
            displayName: 'Local pinned workspace'
          })
          const local = {
            ...sourceWorktree,
            hostId: 'local' as const,
            isPinned: true,
            displayName: 'Local pinned workspace'
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
            isPinned: true,
            isMainWorktree: false,
            displayName: 'Remote pinned workspace'
          }
          state.setActiveView('terminal')
          state.setSidebarOpen(true)
          await window.api.ui.set({ groupBy: 'none' })
          state.setShowSleepingWorkspaces(true)
          state.setHideDefaultBranchWorkspace(false)
          state.setFilterRepoIds([])
          const collapsedGroups = [
            'pinned',
            `pinned:host:${hostId}`,
            ...(collapsedHost ? [`host:${hostId}`] : [])
          ]
          await window.api.ui.set({ collapsedGroups })
          store.setState({
            groupBy: 'none',
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
        { hostId, collapsedHost }
      )
      const pins = orcaPage.getByRole('button', { name: /^Pinned/ })
      const localRow = orcaPage.locator(
        `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.local)}]`
      )
      const remoteRow = orcaPage.locator(
        `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.remote)}]`
      )
      await expect(pins.first()).toHaveAttribute('aria-expanded', 'false')
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
      await expect(pins).toHaveCount(2)
      await expect(pins.first()).toHaveAttribute('aria-expanded', 'false')
      await expect(pins.last()).toHaveAttribute('aria-expanded', 'true')
      await expect(localRow).toHaveCount(0)

      await pins.last().click()
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
      await expect(pins.first()).toHaveAttribute('aria-expanded', 'true')
      await expect(pins.last()).toHaveAttribute('aria-expanded', 'false')
      await expect(remoteRow).toHaveCount(0)
    })
  }
}
