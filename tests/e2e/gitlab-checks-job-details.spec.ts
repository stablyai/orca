import type { Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { openChecks } from './helpers/source-control-ai-generation'
import {
  GITLAB_CHECKS_FIXTURE,
  installGitLabChecksBackend,
  linkGitLabMRToWorktree
} from './helpers/gitlab-checks-fixture'

async function resolveActiveWorktreeId(page: Page): Promise<string> {
  const worktreeId = await page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null)
  if (!worktreeId) {
    throw new Error('E2E fixture did not expose an active worktree')
  }
  return worktreeId
}

test.describe('GitLab Checks panel job details', () => {
  test('expands a failed pipeline job to show its log excerpt', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    await installGitLabChecksBackend(electronApp)
    const worktreeId = await resolveActiveWorktreeId(orcaPage)
    await linkGitLabMRToWorktree(orcaPage, worktreeId, GITLAB_CHECKS_FIXTURE.mrNumber)

    await openChecks(orcaPage, worktreeId)

    // The pipeline job renders as a check row labelled "<stage>: <name>".
    const rowLabel = `${GITLAB_CHECKS_FIXTURE.stage}: ${GITLAB_CHECKS_FIXTURE.jobName}`
    const jobRow = orcaPage.getByText(rowLabel, { exact: true })
    await expect(jobRow).toBeVisible({ timeout: 10_000 })

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `gitlab-checks-job-details-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    await orcaPage.screenshot({
      path: path.join(screenshotDir, '01-gitlab-checks-job-collapsed.png')
    })

    // Expand the job row → the fix loads the trace instead of showing
    // "No inline details are available for this check." The inline panel keeps
    // the full log behind "View full logs" (matching GitHub), so assert the
    // failed-jobs section and the log-tail affordance render.
    await jobRow.click()

    await expect(orcaPage.getByText('No inline details are available for this check.')).toHaveCount(
      0
    )
    const viewFullLogs = orcaPage.getByRole('button', { name: 'View full logs' })
    await expect(viewFullLogs).toBeVisible({ timeout: 10_000 })
    await expect(orcaPage.getByText('Log tail available in full details.')).toBeVisible()

    await orcaPage.screenshot({
      path: path.join(screenshotDir, '02-gitlab-checks-job-expanded.png')
    })

    // Open the full-details tab → the actual trace renders in the editor.
    await viewFullLogs.click()
    await expect(orcaPage.getByText('AssertionError: expected refunded amount')).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.getByText('ERROR: Job failed: exit code 1')).toBeVisible()

    await orcaPage.screenshot({
      path: path.join(screenshotDir, '03-gitlab-checks-job-full-logs.png')
    })
  })
})
