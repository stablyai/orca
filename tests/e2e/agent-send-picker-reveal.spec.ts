import { expect, test } from './helpers/orca-app'
import {
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'

for (const hostId of ['local', 'ssh:picker-builder'] as const) {
  for (const hiddenBy of ['host', 'parent'] as const) {
    test(`agent send picker reveals ${hostId} target hidden by ${hiddenBy} and restores collapse on close`, async ({
      orcaPage
    }, testInfo) => {
      await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await waitForStartupWorktreeRefresh(orcaPage)
      const ids = await orcaPage.evaluate(
        async ({ hostId, hiddenBy }) => {
          const store = window.__store!
          const state = store.getState()
          const sourceRepo = state.repos[0]
          const source = state.worktreesByRepo[sourceRepo.id][0]
          const remoteHostId = hostId === 'local' ? 'ssh:picker-builder' : hostId
          const remoteRepo = {
            ...sourceRepo,
            id: 'picker-remote-repo',
            displayName: 'Remote project',
            executionHostId: remoteHostId,
            connectionId: remoteHostId.startsWith('ssh:') ? 'picker-builder' : null
          }
          const local = {
            ...source,
            hostId: 'local' as const,
            isPinned: false,
            displayName: 'Local workspace'
          }
          const remote = {
            ...source,
            id: 'picker-remote-parent',
            repoId: remoteRepo.id,
            hostId: remoteHostId,
            instanceId: 'remote-parent-instance',
            isMainWorktree: false,
            isPinned: false,
            displayName: 'Remote workspace'
          }
          const parent = hostId === 'local' ? local : remote
          const now = Date.now()
          const localChild = state.worktreesByRepo[sourceRepo.id].find(
            (worktree) => worktree.id !== source.id
          )
          const child =
            hostId === 'local'
              ? localChild
              : {
                  ...parent,
                  id: 'picker-child',
                  instanceId: 'picker-child-instance',
                  isMainWorktree: false
                }
          if (hiddenBy === 'parent' && !child) {
            throw new Error('Seeded child workspace missing')
          }
          const targetId = hiddenBy === 'parent' ? child!.id : parent.id
          const target = {
            ...parent,
            ...(hiddenBy === 'parent' ? child : {}),
            displayName: hiddenBy === 'parent' ? 'Child workspace' : parent.displayName,
            diffComments: [
              {
                id: 'picker-note',
                worktreeId: targetId,
                filePath: 'README.md',
                source: 'diff' as const,
                lineNumber: 1,
                body: 'Check sidebar disclosure',
                side: 'modified' as const,
                createdAt: now
              }
            ]
          }
          if (hostId === 'local') {
            await state.updateWorktreeMeta(
              target.id,
              {
                displayName: target.displayName,
                isPinned: false,
                diffComments: target.diffComments
              },
              { executionHostId: 'local' }
            )
            if (hiddenBy === 'parent') {
              await state.assignWorktreeParent(target.id, { parentWorktreeId: parent.id })
            }
          }
          const localWorktrees =
            hostId === 'local' ? (hiddenBy === 'parent' ? [local, target] : [target]) : [local]
          const remoteWorktrees =
            hostId !== 'local' ? (hiddenBy === 'parent' ? [remote, target] : [target]) : [remote]
          const collapsedGroups = [
            hiddenBy === 'host' ? `host:${hostId}` : `lineage:${hostId}|${parent.id}`
          ]
          const worktreeLineageById =
            hiddenBy === 'parent'
              ? {
                  [target.id]: {
                    worktreeId: target.id,
                    worktreeInstanceId: target.instanceId!,
                    parentWorktreeId: parent.id,
                    parentWorktreeInstanceId: parent.instanceId!,
                    origin: 'orchestration' as const,
                    capture: {
                      source: 'orchestration-context' as const,
                      confidence: 'explicit' as const
                    },
                    createdAt: now
                  }
                }
              : {}
          const tabId = 'picker-agent-tab'
          const leafId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          const paneKey = `${tabId}:${leafId}`
          const ptyId = 'picker-agent-pty'
          await window.api.ui.set({ groupBy: 'none', collapsedGroups })
          state.setSidebarOpen(true)
          state.setShowSleepingWorkspaces(true)
          state.setHideDefaultBranchWorkspace(false)
          state.setFilterRepoIds([])
          state.setRightSidebarTab('source-control')
          state.setRightSidebarOpen(true)
          store.setState({
            groupBy: 'none',
            repos: [sourceRepo, remoteRepo],
            worktreesByRepo: { [sourceRepo.id]: localWorktrees, [remoteRepo.id]: remoteWorktrees },
            worktreeLineageById,
            visibleWorkspaceHostIds: ['local', remoteHostId],
            workspaceHostScope: 'all',
            activeRepoId: target.repoId,
            activeWorktreeId: target.id,
            activeWorkspaceKey: `worktree:${target.id}`,
            activeWorkspaceExecutionHostId: hostId,
            pendingRevealWorktree: null,
            agentSendPopoverTargetMode: null,
            collapsedGroups: new Set(collapsedGroups),
            agentActivityDisplayMode: 'compact',
            worktreeCardProperties: [
              ...state.worktreeCardProperties.filter((property) => property !== 'inline-agents'),
              'inline-agents'
            ],
            sshTargetLabels: new Map([['picker-builder', 'Remote builder']]),
            sshConnectionStates: new Map([
              [
                'picker-builder',
                {
                  targetId: 'picker-builder',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0
                }
              ]
            ]),
            tabsByWorktree: {
              ...state.tabsByWorktree,
              [target.id]: [
                ...(state.tabsByWorktree[target.id] ?? []),
                {
                  id: tabId,
                  worktreeId: target.id,
                  ptyId,
                  title: 'Claude',
                  customTitle: null,
                  color: null,
                  sortOrder: 1,
                  createdAt: now
                }
              ]
            },
            terminalLayoutsByTabId: {
              ...state.terminalLayoutsByTabId,
              [tabId]: {
                root: { type: 'leaf', leafId },
                activeLeafId: leafId,
                expandedLeafId: null,
                ptyIdsByLeafId: { [leafId]: ptyId }
              }
            },
            ptyIdsByTabId: { ...state.ptyIdsByTabId, [tabId]: [ptyId] },
            agentStatusByPaneKey: {
              ...state.agentStatusByPaneKey,
              [paneKey]: {
                state: 'working',
                prompt: 'Check sidebar disclosure',
                updatedAt: now,
                stateStartedAt: now,
                agentType: 'claude',
                paneKey,
                worktreeId: target.id,
                stateHistory: []
              }
            }
          })
          return {
            target: target.id,
            control: hostId === 'local' ? remote.id : local.id,
            collapsedGroups
          }
        },
        { hostId, hiddenBy }
      )
      const targetRow = orcaPage.locator(
        `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.target)}]`
      )
      const controlRow = orcaPage.locator(
        `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.control)}]`
      )
      await expect(targetRow).toHaveCount(0)
      await expect(controlRow).toBeVisible()
      const sendButton = orcaPage.getByRole('button', {
        name: 'Send notes to an agent',
        exact: true
      })
      await expect(sendButton).toBeEnabled()
      await orcaPage.screenshot({
        path: testInfo.outputPath('before-picker.png'),
        clip: { x: 0, y: 170, width: 280, height: 500 }
      })
      await sendButton.click()
      await expect(orcaPage.getByText('Send notes to', { exact: true })).toBeVisible()
      try {
        await expect(targetRow).toBeVisible()
        await expect(targetRow.locator('[data-agent-send-target="eligible"]')).toBeVisible()
      } finally {
        await orcaPage.screenshot({
          path: testInfo.outputPath('after-picker.png'),
          clip: { x: 0, y: 170, width: 280, height: 500 }
        })
      }
      await expect(controlRow).toBeVisible()
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree))
        .toBeNull()
      await orcaPage.keyboard.press('Escape')
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store!.getState().agentSendPopoverTargetMode))
        .toBeNull()
      await expect(targetRow).toHaveCount(0)
      expect(
        await orcaPage.evaluate(() => [...window.__store!.getState().collapsedGroups])
      ).toEqual(ids.collapsedGroups)
      expect(
        await orcaPage.evaluate(async () => (await window.api.ui.get()).collapsedGroups)
      ).toEqual(ids.collapsedGroups)
    })
  }
}
