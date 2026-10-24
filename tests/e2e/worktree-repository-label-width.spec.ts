import { runProcess } from '@orca/process-host'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'

const repositoryName = 'tfmod-aws-base-network'
const branchName = 'feature/configure-network-access'

test.use({ minimumSeededWorktreeCount: 1 })

for (const theme of ['light', 'dark'] as const) {
  test(`repository labels use available sidebar width in ${theme} mode`, async ({
    orcaPage: page
  }, testInfo) => {
    await waitForSessionReady(page)
    await waitForStartupWorktreeRefresh(page)
    const worktreePath = await page.evaluate(() => {
      const state = window.__store?.getState()
      const repo = state?.repos[0]
      const worktree = repo && state?.worktreesByRepo[repo.id]?.[0]
      if (!worktree) {
        throw new Error('Missing seeded workspace')
      }
      return worktree.path
    })
    /** Renames the real Git branch so catalog refreshes preserve the test identity. */
    const renameBranch = async (name: string): Promise<void> => {
      const result = await runProcess({
        program: 'git',
        args: ['branch', '-m', name],
        cwd: worktreePath
      })
      if (result.code !== 0) {
        throw new Error(`Could not rename seeded branch: ${result.stderr}`)
      }
    }
    await renameBranch(branchName)
    const worktreeId = await page.evaluate(
      ({ theme, repositoryName, branchName }) => {
        const store = window.__store
        const state = store?.getState()
        const repo = state?.repos[0]
        const worktree = repo && state?.worktreesByRepo[repo.id]?.[0]
        if (!store || !state?.settings || !repo || !worktree) {
          throw new Error('Missing seeded repository and workspace')
        }
        state.setSidebarOpen(true)
        state.setGroupBy('none')
        store.setState({
          sidebarWidth: 500,
          worktreeCardProperties: ['branch'],
          settings: {
            ...state.settings,
            theme,
            compactWorktreeCards: false,
            experimentalNewWorktreeCardStyle: false
          },
          repos: state.repos.map((item) =>
            item.id === repo.id ? { ...item, displayName: repositoryName } : item
          ),
          worktreesByRepo: {
            ...state.worktreesByRepo,
            [repo.id]: state.worktreesByRepo[repo.id].map((item) =>
              item.id === worktree.id ? { ...item, branch: branchName, isPinned: false } : item
            )
          }
        })
        return worktree.id
      },
      { theme, repositoryName, branchName }
    )
    const metadata = page
      .locator(`[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(worktreeId)}]`)
      .locator('[data-worktree-card-meta-row]')
      .first()
    const repositoryLabel = metadata.getByText(repositoryName, { exact: true })
    const branchLabel = metadata.getByText(branchName, { exact: true })
    await expect(repositoryLabel).toBeVisible()
    await expect(branchLabel).toBeVisible()
    await expect
      .poll(() => repositoryLabel.evaluate((element) => element.clientWidth >= element.scrollWidth))
      .toBe(true)
    await expect
      .poll(() => branchLabel.evaluate((element) => element.clientWidth >= element.scrollWidth))
      .toBe(true)
    const wideWidth = await repositoryLabel.evaluate((element) => element.clientWidth)
    expect(wideWidth).toBeGreaterThan(96)
    await metadata.screenshot({ path: testInfo.outputPath(`repository-wide-${theme}.png`) })

    for (const width of [220, 280]) {
      await page.evaluate((width) => window.__store?.getState().setSidebarWidth(width), width)
      await expect
        .poll(() =>
          metadata.evaluate((element) => {
            const container = element.parentElement
            return container ? container.getBoundingClientRect().width : 0
          })
        )
        .toBeLessThanOrEqual(width)
      await expect(repositoryLabel).toBeVisible()
      await expect(branchLabel).toBeVisible()
      const geometry = await metadata.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const labels = Array.from(element.querySelectorAll('span')).filter(
          (span) => span.textContent && span.classList.contains('truncate')
        )
        return {
          overflows: element.scrollWidth > element.clientWidth,
          labelsFit: labels.every((label) => {
            const rect = label.getBoundingClientRect()
            return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1
          })
        }
      })
      expect(geometry.overflows).toBe(false)
      expect(geometry.labelsFit).toBe(true)
      await metadata.screenshot({ path: testInfo.outputPath(`repository-${width}-${theme}.png`) })
    }

    await renameBranch('main')
    await page.evaluate(async () => {
      await window.__store?.getState().fetchAllWorktrees()
    })
    await expect(metadata.getByText('main', { exact: true })).toBeVisible()
    await expect
      .poll(() => repositoryLabel.evaluate((element) => element.clientWidth >= element.scrollWidth))
      .toBe(true)
    await metadata.screenshot({ path: testInfo.outputPath(`repository-short-branch-${theme}.png`) })
  })
}
