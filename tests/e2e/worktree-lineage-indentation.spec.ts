import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { LINEAGE_IMMEDIATE_PARENT_STEP } from '../../src/renderer/src/components/sidebar/worktree-list/rows/indentation'

test.use({ minimumSeededWorktreeCount: 1 })

for (const compactCards of [false, true]) {
  test(`legacy lineage keeps a local title step (${compactCards ? 'compact' : 'detailed'})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    for (const showStatus of [false, true]) {
      for (const group of ['none', 'repo', 'manual', 'deep-manual', 'deep-folder'] as const) {
        await orcaPage.evaluate(
          ({ compactCards, showStatus, group }) => {
            const store = window.__store
            if (!store) {
              throw new Error('Missing app store')
            }
            const state = store.getState()
            if (!state.settings) {
              throw new Error('Missing app settings')
            }
            const repo = state.repos[0]!
            const template = state.worktreesByRepo[repo.id]![0]!
            const depth = group.startsWith('deep-') ? 3 : group === 'manual' ? 1 : 0
            const projectGroups = Array.from({ length: depth }, (_, index) => ({
              id: `indent-group-${index}`,
              name: `Indent group ${index}`,
              parentPath: repo.path,
              parentGroupId: index > 0 ? `indent-group-${index - 1}` : null,
              createdFrom: group === 'deep-folder' ? ('folder-scan' as const) : ('manual' as const),
              tabOrder: index,
              isCollapsed: false,
              color: null,
              createdAt: 1,
              updatedAt: 1
            }))
            const worktrees = Array.from({ length: 4 }, (_, index) => ({
              ...template,
              id: `${repo.id}::indent-${index}`,
              instanceId: `indent-instance-${index}`,
              displayName: `Level ${index} workspace`,
              branch: `indent-${index}`,
              isMainWorktree: false,
              isPinned: false,
              isArchived: false,
              parentWorktreeId: null,
              childWorktreeIds: [],
              lineage: null,
              linkedIssue: null,
              linkedPR: null,
              linkedGitLabMR: null,
              linkedLinearIssue: null,
              comment: '',
              sortOrder: index
            }))
            const lineage = Object.fromEntries(
              worktrees.slice(1).map((child, index) => [
                child.id,
                {
                  worktreeId: child.id,
                  worktreeInstanceId: child.instanceId,
                  parentWorktreeId: worktrees[index]!.id,
                  parentWorktreeInstanceId: worktrees[index]!.instanceId,
                  origin: 'manual' as const,
                  capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
                  createdAt: 1
                }
              ])
            )
            store.setState({
              repos: [{ ...repo, projectGroupId: projectGroups.at(-1)?.id ?? null }],
              worktreesByRepo: { [repo.id]: worktrees },
              worktreeLineageById: lineage,
              projectGroups,
              settings: {
                ...state.settings,
                experimentalNewWorktreeCardStyle: false,
                compactWorktreeCards: compactCards
              },
              worktreeCardProperties: showStatus ? ['status'] : [],
              groupBy: group === 'none' ? 'none' : 'repo',
              sortBy: 'manual',
              sidebarOpen: true,
              activeWorktreeId: null,
              showActiveOnly: false,
              showSleepingWorkspaces: true,
              hideDefaultBranchWorkspace: false,
              filterRepoIds: [],
              workspaceHostScope: 'all',
              collapsedGroups: new Set()
            })
          },
          { compactCards, showStatus, group }
        )

        const sidebar = orcaPage.locator('[data-worktree-sidebar]')
        await expect(sidebar.locator('[data-worktree-card-status-slot]')).toHaveCount(
          showStatus ? 4 : 0
        )
        for (let level = 0; level < 4; level++) {
          const title = sidebar.getByText(`Level ${level} workspace`, { exact: true })
          await expect(title).toBeVisible()
          await expect
            .poll(async () => {
              const box = await title.boundingBox()
              return box?.width ?? 0
            })
            .toBeGreaterThan(60)
          if (level === 0) {
            continue
          }
          const parent = sidebar.getByText(`Level ${level - 1} workspace`, { exact: true })
          await expect
            .poll(async () => {
              const childBox = await title.boundingBox()
              const parentBox = await parent.boundingBox()
              return childBox && parentBox ? childBox.x - parentBox.x : null
            })
            .toBeCloseTo(LINEAGE_IMMEDIATE_PARENT_STEP + 1, 0)
        }
        await orcaPage.screenshot({
          path: testInfo.outputPath(`${group}-status-${showStatus}.png`)
        })
      }
    }
  })
}
