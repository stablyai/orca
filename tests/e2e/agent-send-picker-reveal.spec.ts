import { expect, test } from './helpers/orca-app'
import { evaluatePolled } from './helpers/page-evaluate-polled'
import { launchWithUnreachableSshWorkspaces } from './helpers/seeded-ssh-workspaces'

for (const host of ['local', 'ssh'] as const) {
  for (const hiddenBy of ['host', 'parent'] as const) {
    test(`agent send picker reveals ${host} target hidden by ${hiddenBy} and restores collapse on close`, async ({
      testRepoPath
    }, testInfo) => {
      test.setTimeout(3 * 60_000)
      const launched = await launchWithUnreachableSshWorkspaces(testInfo, testRepoPath, {
        label: 'Remote builder',
        workspaces: [
          { name: 'parent', displayName: 'Remote workspace' },
          { name: 'child', displayName: 'Remote child' }
        ]
      })
      try {
        const { page, ssh, localWorktreeId } = launched
        await page.emulateMedia({ reducedMotion: 'reduce' })
        const ids = await evaluatePolled(
          page,
          async ({ host, hiddenBy, ssh, localWorktreeId }) => {
            const store = window.__store!
            const state = store.getState()
            const localChild = Object.values(state.worktreesByRepo)
              .flat()
              .find((worktree) => worktree.hostId === 'local' && worktree.id !== localWorktreeId)
            const hostId = host === 'local' ? 'local' : ssh.hostId
            const parent = host === 'local' ? localWorktreeId : ssh.worktreeIds.parent!
            const child = host === 'local' ? localChild?.id : ssh.worktreeIds.child
            if (hiddenBy === 'parent' && !child) {
              throw new Error('Seeded child workspace missing')
            }
            const target = hiddenBy === 'parent' ? child! : parent
            const now = Date.now()
            const noted = await state.updateWorktreeMeta(
              target,
              {
                ...(hiddenBy === 'parent' ? { displayName: 'Child workspace' } : {}),
                isPinned: false,
                diffComments: [
                  {
                    id: 'picker-note',
                    worktreeId: target,
                    filePath: 'README.md',
                    source: 'diff' as const,
                    lineNumber: 1,
                    body: 'Check sidebar disclosure',
                    side: 'modified' as const,
                    createdAt: now
                  }
                ]
              },
              { executionHostId: hostId }
            )
            if (!noted.ok) {
              throw new Error(`Writing the note failed: ${noted.error}`)
            }
            if (hiddenBy === 'parent') {
              await state.assignWorktreeParent(target, { parentWorktreeId: parent })
            }
            const targetRepoId = Object.values(store.getState().worktreesByRepo)
              .flat()
              .find((worktree) => worktree.id === target)!.repoId
            const collapsedGroups = [
              hiddenBy === 'host' ? `host:${hostId}` : `lineage:${hostId}|${parent}`
            ]
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
            const current = store.getState()
            store.setState({
              groupBy: 'none',
              visibleWorkspaceHostIds: ['local', ssh.hostId],
              workspaceHostScope: 'all',
              activeRepoId: targetRepoId,
              activeWorktreeId: target,
              activeWorkspaceKey: `worktree:${target}`,
              activeWorkspaceExecutionHostId: hostId,
              pendingRevealWorktree: null,
              agentSendPopoverTargetMode: null,
              collapsedGroups: new Set(collapsedGroups),
              agentActivityDisplayMode: 'compact',
              worktreeCardProperties: [
                ...current.worktreeCardProperties.filter(
                  (property) => property !== 'inline-agents'
                ),
                'inline-agents'
              ],
              tabsByWorktree: {
                ...current.tabsByWorktree,
                [target]: [
                  ...(current.tabsByWorktree[target] ?? []),
                  {
                    id: tabId,
                    worktreeId: target,
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
                ...current.terminalLayoutsByTabId,
                [tabId]: {
                  root: { type: 'leaf', leafId },
                  activeLeafId: leafId,
                  expandedLeafId: null,
                  ptyIdsByLeafId: { [leafId]: ptyId }
                }
              },
              ptyIdsByTabId: { ...current.ptyIdsByTabId, [tabId]: [ptyId] },
              agentStatusByPaneKey: {
                ...current.agentStatusByPaneKey,
                [paneKey]: {
                  state: 'working',
                  prompt: 'Check sidebar disclosure',
                  updatedAt: now,
                  stateStartedAt: now,
                  agentType: 'claude',
                  paneKey,
                  worktreeId: target,
                  stateHistory: []
                }
              }
            })
            return {
              target,
              control: host === 'local' ? ssh.worktreeIds.parent! : localWorktreeId,
              collapsedGroups
            }
          },
          { host, hiddenBy, ssh, localWorktreeId }
        )
        const targetRow = page.locator(
          `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.target)}]`
        )
        const controlRow = page.locator(
          `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(ids.control)}]`
        )
        await expect(targetRow).toHaveCount(0)
        await expect(controlRow).toBeVisible()
        const sendButton = page.getByRole('button', {
          name: 'Send notes to an agent',
          exact: true
        })
        await expect(sendButton).toBeEnabled()
        await page.screenshot({
          path: testInfo.outputPath('before-picker.png'),
          clip: { x: 0, y: 170, width: 280, height: 500 }
        })
        await sendButton.click()
        await expect(page.getByText('Send notes to', { exact: true })).toBeVisible()
        try {
          await expect(targetRow).toBeVisible()
          await expect(targetRow.locator('[data-agent-send-target="eligible"]')).toBeVisible()
        } finally {
          await page.screenshot({
            path: testInfo.outputPath('after-picker.png'),
            clip: { x: 0, y: 170, width: 280, height: 500 }
          })
        }
        await expect(controlRow).toBeVisible()
        await expect
          .poll(() => page.evaluate(() => window.__store!.getState().pendingRevealWorktree))
          .toBeNull()
        await page.keyboard.press('Escape')
        await expect
          .poll(() => page.evaluate(() => window.__store!.getState().agentSendPopoverTargetMode))
          .toBeNull()
        await expect(targetRow).toHaveCount(0)
        expect(await page.evaluate(() => [...window.__store!.getState().collapsedGroups])).toEqual(
          ids.collapsedGroups
        )
        expect(
          await page.evaluate(async () => (await window.api.ui.get()).collapsedGroups)
        ).toEqual(ids.collapsedGroups)
      } finally {
        await launched.dispose()
      }
    })
  }
}
