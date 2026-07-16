import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

const RENDER_LINT_PATH = process.env.PR_RENDER_LINT_PATH
const RENDER_ARTIFACT_DIR = process.env.PR_RENDER_ARTIFACT_DIR
const CAPTURE_RENDER_PROOF = Boolean(RENDER_LINT_PATH && RENDER_ARTIFACT_DIR)
const RENDER_LINT_SOURCE =
  CAPTURE_RENDER_PROOF && RENDER_LINT_PATH ? readFileSync(RENDER_LINT_PATH, 'utf8') : null
const RENDER_SWEEP = [
  { width: 1280, height: 800, suffix: '' },
  { width: 1024, height: 768, suffix: '-1024' },
  { width: 800, height: 600, suffix: '-800' }
]

type SidebarVisibilityScenario = {
  defaultBranchId: string
  featureId: string
}

function sidebar(page: Parameters<typeof test>[0]['orcaPage']) {
  return page.locator('[data-worktree-sidebar]').first()
}

function afterShotPath(suffix: string): string {
  return resolve(RENDER_ARTIFACT_DIR!, `orca-PR-TARGET-8873-after${suffix}.png`)
}

async function collectRenderViolations(
  page: Parameters<typeof test>[0]['orcaPage'],
  scopeSelector: string
): Promise<unknown[]> {
  return page.evaluate(
    ({ source, scopeSelector }) => {
      const collect = new Function(
        'selector',
        'options',
        `var module = { exports: {} }; var exports = module.exports; ${source}; return collectRenderViolations(selector, options);`
      ) as (selector: string, options: Record<string, unknown>) => unknown[]
      return collect(scopeSelector, {
        checks: ['overlap', 'clip', 'container-escape', 'raw-string', 'a11y']
      })
    },
    { source: RENDER_LINT_SOURCE, scopeSelector }
  )
}

async function captureRenderProof(
  page: Parameters<typeof test>[0]['orcaPage'],
  defaultBranchRow: ReturnType<typeof worktreeRow>,
  featureRow: ReturnType<typeof worktreeRow>
): Promise<void> {
  if (!CAPTURE_RENDER_PROOF) {
    return
  }

  mkdirSync(RENDER_ARTIFACT_DIR!, { recursive: true })
  const lintResults: Record<string, unknown[]> = {}
  for (const sweep of RENDER_SWEEP) {
    await page.setViewportSize({ width: sweep.width, height: sweep.height })
    await expect(defaultBranchRow).toBeVisible()
    await expect(featureRow).toHaveCount(0)
    const violations = await collectRenderViolations(page, '[data-worktree-sidebar]')
    lintResults[`${sweep.width}`] = violations
    await sidebar(page).screenshot({ path: afterShotPath(sweep.suffix) })
  }
  console.log(`render lint ${JSON.stringify(lintResults)}`)
}

async function seedSidebarVisibilityScenario(
  page: Parameters<typeof test>[0]['orcaPage']
): Promise<SidebarVisibilityScenario> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const repo = state.repos[0]
    if (!repo) {
      throw new Error('Sidebar visibility E2E needs a seeded repo')
    }

    const currentWorktree = (state.worktreesByRepo[repo.id] ?? [])[0]
    if (!currentWorktree) {
      throw new Error('Sidebar visibility E2E needs a seeded worktree')
    }

    const defaultBranchId = 'e2e-default-branch-visibility-main'
    const featureId = 'e2e-default-branch-visibility-feature'
    const currentId = currentWorktree.id

    store.setState((current) => ({
      worktreesByRepo: {
        ...current.worktreesByRepo,
        [repo.id]: [
          {
            ...currentWorktree,
            id: currentId,
            displayName: 'Current workspace',
            isMainWorktree: false,
            branch: 'refs/heads/current',
            lastActivityAt: 3
          },
          {
            ...currentWorktree,
            id: defaultBranchId,
            displayName: 'Default branch workspace',
            isMainWorktree: true,
            branch: 'refs/heads/main',
            lastActivityAt: 2
          },
          {
            ...currentWorktree,
            id: featureId,
            displayName: 'Feature workspace',
            isMainWorktree: false,
            branch: 'refs/heads/feature',
            lastActivityAt: 1
          }
        ]
      },
      tabsByWorktree: {
        ...current.tabsByWorktree,
        [defaultBranchId]: [],
        [featureId]: []
      },
      browserTabsByWorktree: {
        ...current.browserTabsByWorktree,
        [defaultBranchId]: [],
        [featureId]: []
      }
    }))

    const nextState = store.getState()
    nextState.setActiveView('terminal')
    nextState.setSidebarOpen(true)
    nextState.setGroupBy('none')
    nextState.setSortBy('recent')
    nextState.setShowActiveOnly(false)
    nextState.setFilterRepoIds([])

    return { defaultBranchId, featureId }
  })
}

test.describe('Default branch visibility', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('keeps the default branch visible when sleeping workspaces are hidden', async ({
    orcaPage
  }) => {
    const { defaultBranchId, featureId } = await seedSidebarVisibilityScenario(orcaPage)
    const defaultBranchRow = worktreeRow(orcaPage, defaultBranchId)
    const featureRow = worktreeRow(orcaPage, featureId)

    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ defaultBranchId, featureId }) => {
            const state = window.__store?.getState()
            state?.setShowSleepingWorkspaces(false)
            state?.setHideDefaultBranchWorkspace(false)
            const featureTabs = state?.tabsByWorktree[featureId] ?? []
            return {
              defaultBranchTabs: state?.tabsByWorktree[defaultBranchId]?.length ?? 0,
              featureBrowserTabs: state?.browserTabsByWorktree[featureId]?.length ?? 0,
              featureHasLivePty: featureTabs.some(
                (tab) => (state?.ptyIdsByTabId[tab.id] ?? []).length > 0
              ),
              featureTabs: featureTabs.length,
              hideDefaultBranchWorkspace: state?.hideDefaultBranchWorkspace ?? null,
              showSleepingWorkspaces: state?.showSleepingWorkspaces ?? null
            }
          },
          { defaultBranchId, featureId }
        )
      )
      .toEqual({
        defaultBranchTabs: 0,
        featureBrowserTabs: 0,
        featureHasLivePty: false,
        featureTabs: 0,
        hideDefaultBranchWorkspace: false,
        showSleepingWorkspaces: false
      })

    await expect(defaultBranchRow).toBeVisible()
    await expect(defaultBranchRow).toContainText('Default branch workspace')
    await expect(featureRow).toHaveCount(0)
    await captureRenderProof(orcaPage, defaultBranchRow, featureRow)

    await orcaPage.evaluate(() => {
      window.__store?.getState().setHideDefaultBranchWorkspace(true)
    })

    await expect(defaultBranchRow).toHaveCount(0)
  })
})
