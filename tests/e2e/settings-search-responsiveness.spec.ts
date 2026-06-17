import path from 'path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { Repo } from '../../src/shared/types'

const MATCHING_PROJECT_COUNT = 240

function buildProjectPaths(): string[] {
  return Array.from({ length: MATCHING_PROJECT_COUNT }, (_, index) =>
    path.join(process.cwd(), '.e2e-settings-search', `project-${String(index).padStart(3, '0')}`)
  )
}

test.describe('Settings search responsiveness', () => {
  test('renders only the active settings pane when many projects match search', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)

    await orcaPage.evaluate(
      ({ projectPaths, projectCount }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        const seedRepo = state.repos[0]
        if (!seedRepo) {
          throw new Error('Expected seeded repo for settings search regression')
        }
        const now = Date.now()
        const repos: Repo[] = Array.from({ length: projectCount }, (_, index) => ({
          ...seedRepo,
          id: `settings-search-repo-${index}`,
          path: projectPaths[index],
          displayName: `Project Long Search ${String(index).padStart(3, '0')}`,
          addedAt: now + index,
          upstream: null,
          hookSettings: undefined
        }))
        store.setState({ repos })
        state.openSettingsPage()
      },
      { projectPaths: buildProjectPaths(), projectCount: MATCHING_PROJECT_COUNT }
    )

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('Project Long Search')

    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().settingsSearchQuery ?? ''), {
        timeout: 5_000,
        message: 'settings search query did not apply'
      })
      .toBe('Project Long Search')

    await expect(orcaPage.getByRole('button', { name: 'Project Long Search 000' })).toBeVisible()
    await expect
      .poll(() => orcaPage.locator('section.scroll-mt-8[data-settings-section]').count(), {
        timeout: 5_000,
        message: 'settings search rendered more than the active pane'
      })
      .toBe(1)

    const renderedSectionId = await orcaPage
      .locator('section.scroll-mt-8[data-settings-section]')
      .first()
      .getAttribute('data-settings-section')
    expect(renderedSectionId).toBe('repo-settings-search-repo-0')
  })
})
