import { expect, test } from './helpers/orca-app'
import {
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'

test.use({ minimumSeededWorktreeCount: 1 })

test('Activity agent rows keep their project across working, waiting, and done states', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const workingTask = 'Audit the checkout flow'
  const waitingTask = 'Review the checkout copy'
  const doneTask = 'Document the checkout flow'
  const { workspaceName } = await orcaPage.evaluate(
    async ({ worktreeId, workingTask, waitingTask, doneTask }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id === worktreeId)
      const repo = state.repos.find((candidate) => candidate.id === worktree?.repoId)
      const tab = state.tabsByWorktree[worktreeId]?.[0]
      if (!worktree || !repo || !tab) {
        throw new Error('The seeded project needs a workspace and terminal tab')
      }

      const now = Date.now()
      await state.updateRepo(repo.id, { displayName: 'Project A' })
      state.setAgentsGroupBy('status')
      const statuses = [
        { leafId: '11111111-1111-4111-8111-111111111111', task: workingTask, state: 'working' },
        { leafId: '22222222-2222-4222-8222-222222222222', task: waitingTask, state: 'waiting' },
        { leafId: '33333333-3333-4333-8333-333333333333', task: doneTask, state: 'done' }
      ] as const
      for (const status of statuses) {
        store
          .getState()
          .setAgentStatus(
            `${tab.id}:${status.leafId}`,
            { state: status.state, prompt: status.task, agentType: 'codex' },
            'Codex',
            { updatedAt: now, stateStartedAt: now },
            { tabId: tab.id, worktreeId, terminalHandle: `project-prefix-${status.state}` }
          )
      }
      const settings = await window.api.settings.set({ agentsSidebarIntroShown: true })
      store.setState({ settings })
      return { workspaceName: worktree.displayName }
    },
    { worktreeId, workingTask, waitingTask, doneTask }
  )

  await orcaPage.getByRole('button', { name: 'View activity' }).click()
  const workingRow = orcaPage.getByRole('listitem', { name: `Project A: ${workingTask}` })
  const waitingRow = orcaPage.getByRole('listitem', { name: `Project A: ${waitingTask}` })
  const doneRow = orcaPage.getByRole('listitem', { name: `Project A: ${doneTask}` })
  await expect(workingRow).toBeVisible()
  await expect(workingRow.locator('[data-slot="badge"][data-variant="outline"]')).toHaveText(
    'Project A'
  )
  await expect(workingRow).toContainText(`Project A · ${workingTask}`)
  await expect(workingRow).toContainText(workspaceName)
  await expect(waitingRow).toBeVisible()
  await expect(waitingRow.locator('[data-slot="badge"][data-variant="outline"]')).toHaveText(
    'Project A'
  )
  await expect(doneRow).toBeVisible()
  await expect(doneRow.locator('[data-slot="badge"][data-variant="outline"]')).toHaveText(
    'Project A'
  )
  await testInfo.attach('working-project-prefix', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })

  await orcaPage.getByRole('button', { name: 'Thread list options' }).click()
  await orcaPage.getByRole('menuitem', { name: /Group by/ }).hover()
  await orcaPage.getByRole('menuitemradio', { name: 'Project' }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('group', { name: 'Project A activity' })).toBeVisible()
  for (const task of [workingTask, waitingTask, doneTask]) {
    const groupedRow = orcaPage.getByRole('listitem', { name: task })
    await expect(groupedRow).toBeVisible()
    await expect(groupedRow.locator('[data-slot="badge"]')).toHaveCount(0)
  }
})
