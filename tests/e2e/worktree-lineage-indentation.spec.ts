import { test, expect } from './helpers/orca-app'
import { evaluatePolled } from './helpers/page-evaluate-polled'
import {
  addRepoWithWorkspaces,
  linkWorkspaces,
  writeWorkspaceMeta
} from './helpers/repo-with-workspaces'
import { waitForSessionReady } from './helpers/store'
import { LINEAGE_IMMEDIATE_PARENT_STEP } from '../../src/renderer/src/components/sidebar/worktree-list/rows/indentation'

test.use({ seedTestRepo: false })

for (const compactCards of [false, true]) {
  test(`legacy lineage keeps a local title step (${compactCards ? 'compact' : 'detailed'})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const repo = await addRepoWithWorkspaces(orcaPage, testInfo, 4)
    await writeWorkspaceMeta(
      orcaPage,
      repo.ids.map((worktreeId, index) => ({
        worktreeId,
        updates: { displayName: `Level ${index} workspace`, sortOrder: index }
      }))
    )
    await linkWorkspaces(
      orcaPage,
      repo.ids.slice(1).map((childId, index) => ({ childId, parentId: repo.ids[index]! }))
    )
    for (const showStatus of [false, true]) {
      for (const group of ['none', 'repo', 'manual', 'deep-manual', 'deep-folder'] as const) {
        await evaluatePolled(
          orcaPage,
          async ({ compactCards, showStatus, group, repoId }) => {
            const store = window.__store!
            const state = store.getState()
            // Each pass starts from an ungrouped project, so the last pass's groups go.
            await window.api.projectGroups.moveProject({ projectId: repoId, groupId: null })
            for (const stale of await window.api.projectGroups.list()) {
              await window.api.projectGroups.delete({ groupId: stale.id })
            }
            const depth = group.startsWith('deep-') ? 3 : group === 'manual' ? 1 : 0
            let parentGroupId: string | null = null
            for (let index = 0; index < depth; index++) {
              const created = await window.api.projectGroups.create({
                name: `Indent group ${index}`,
                parentPath: state.repos.find((entry) => entry.id === repoId)!.path,
                parentGroupId,
                createdFrom: group === 'deep-folder' ? 'folder-scan' : 'manual'
              })
              parentGroupId = created.id
            }
            if (parentGroupId) {
              await window.api.projectGroups.moveProject({
                projectId: repoId,
                groupId: parentGroupId
              })
            }
            await state.fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
            await state.fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
            // Persist the view first: its echo re-hydrates the window, which must land before the seed.
            await window.api.ui.set({
              groupBy: group === 'none' ? 'none' : 'repo',
              sortBy: 'manual',
              collapsedGroups: []
            })
            store.setState({
              settings: {
                ...store.getState().settings!,
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
              // The repo's own checkout is not part of the chain.
              hideDefaultBranchWorkspace: true,
              filterRepoIds: [],
              workspaceHostScope: 'all',
              collapsedGroups: new Set()
            })
          },
          { compactCards, showStatus, group, repoId: repo.repoId }
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
