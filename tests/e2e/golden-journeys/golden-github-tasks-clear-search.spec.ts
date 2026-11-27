import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from '../desktop/renderer-probes/store'

test('@golden clears the GitHub Tasks search on the first pointer click', async ({ orcaPage }) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    const { repos, updateSettings } = store.getState()
    store.setState({
      repos: repos.map((repo) => ({
        ...repo,
        displayName: 'example/workbench',
        upstream: { owner: 'example', repo: 'workbench' }
      })),
      getCachedWorkItems: () => [],
      fetchWorkItems: async () => []
    })
    await updateSettings({
      experimentalAppRail: true,
      showTasksButton: true,
      defaultTaskSource: 'github',
      defaultTaskViewPreset: 'my-issues'
    })
  })

  await orcaPage.locator('[data-app-rail-item="tasks"]').click()
  const search = orcaPage.locator('[data-github-items-search-input]')
  await expect(search).toHaveValue('assignee:@me is:issue is:open')
  await orcaPage.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(search).toHaveValue('is:issue is:open')
})
