/**
 * The Create PR intent notice pairs a wrapping sentence with a "Source Control
 * AI settings" link. In a minimum-width sidebar the link must not share the
 * message's row, or it squeezes the sentence into a one-word-per-line column.
 */
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createStagedCommitMessageChange,
  openSourceControl,
  seedCreatePrComposer
} from './helpers/source-control-ai-generation'
import { RIGHT_SIDEBAR_MIN_WIDTH } from '../../src/renderer/src/components/right-sidebar/right-sidebar-width'

test.describe('Source Control Create PR intent notice layout', () => {
  test('keeps the settings link off the message row at the minimum sidebar width', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { prWorktreeId, prWorktreePath, primaryBranch } = await seedCreatePrComposer(orcaPage)
    // A real staged change with no commit draft is what routes the intent run
    // into the "configure Source Control AI" notice, which carries the link.
    createStagedCommitMessageChange(prWorktreePath)

    await orcaPage.evaluate(
      ({ prWorktreeId, primaryBranch }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        store.setState((current) => ({
          // Unconfigured Source Control AI is what routes the run into the
          // "configure Source Control AI" notice rather than a failure notice.
          settings: current.settings
            ? { ...current.settings, sourceControlAi: undefined, commitMessageAi: undefined }
            : current.settings,
          repos: current.repos.map((repo) => ({ ...repo, sourceControlAi: undefined })),
          // Blocked-on-push keeps "Create PR" running the intent flow instead of
          // opening the composer form.
          getHostedReviewCreationEligibility: async () => ({
            provider: 'github' as const,
            review: null,
            reviewLookupOutcome: 'not_found' as const,
            canCreate: false,
            blockedReason: 'needs_push' as const,
            nextAction: 'push' as const,
            defaultBaseRef: primaryBranch,
            head: 'e2e-secondary'
          }),
          fetchHostedReviewForBranch: async () => null,
          fetchPRForBranch: async () => null,
          pushBranch: async (worktreeId: string) => {
            if (worktreeId !== prWorktreeId) {
              throw new Error(`Create PR intent pushed unexpected worktree ${worktreeId}`)
            }
          }
        }))
      },
      { prWorktreeId, primaryBranch }
    )

    await openSourceControl(orcaPage, prWorktreeId)
    await orcaPage.evaluate((minWidth) => {
      window.__store?.getState().setRightSidebarWidth(minWidth)
    }, RIGHT_SIDEBAR_MIN_WIDTH)

    const createPr = orcaPage.getByRole('button', { name: 'Create PR' }).first()
    await expect(createPr).toBeVisible({ timeout: 10_000 })
    await expect(createPr).toBeEnabled()
    await createPr.click()

    const notice = orcaPage.locator('#commit-area-create-pr-intent')
    const settingsLink = notice.getByRole('button', { name: 'Source Control AI settings' })
    await expect(settingsLink).toBeVisible({ timeout: 20_000 })

    if (process.env.ORCA_PR_INTENT_NOTICE_SCREENSHOT_PATH) {
      await orcaPage.evaluate(() => document.documentElement.classList.add('dark'))
      await notice.screenshot({ path: process.env.ORCA_PR_INTENT_NOTICE_SCREENSHOT_PATH })
    }

    // The layout contract: the link starts below the message's last line.
    const messageBox = await notice.locator('span').first().boundingBox()
    const linkBox = await settingsLink.boundingBox()
    expect(messageBox).not.toBeNull()
    expect(linkBox).not.toBeNull()
    expect(linkBox!.y).toBeGreaterThanOrEqual(messageBox!.y + messageBox!.height)
    // A squeezed message wraps far taller than the ~4 lines this sentence needs.
    expect(messageBox!.height).toBeLessThan(70)
  })
})
