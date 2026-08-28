import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { openChecks } from './helpers/source-control-ai-generation'

// Repro for #7732: expanding a GitLab pipeline job in the Checks panel must show its log,
// not "No inline details are available for this check." All fixture data is synthetic.
const FIXTURE = {
  mrNumber: 4242,
  jobId: 987654,
  jobName: 'Purchase API Component Tests',
  stage: 'Component Tests',
  webUrl: 'https://gitlab.example.test/acme/orca/-/jobs/987654',
  mrUrl: 'https://gitlab.example.test/acme/orca/-/merge_requests/4242',
  headSha: 'e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2e',
  trace: [
    '$ pnpm test:component --project purchase-api',
    'FAIL  src/purchase/refund.spec.ts',
    '    AssertionError: expected refunded amount 4200 to equal 4250',
    'ERROR: Job failed: exit code 1'
  ].join('\n')
} as const

const SCREENSHOT_DIR =
  process.env.ORCA_GITLAB_CHECKS_JOB_DETAILS_SCREENSHOT_DIR ??
  path.join(process.cwd(), 'test-results', 'gitlab-checks-job-details')

// contextIsolation makes window.api non-writable, so stub at the IPC boundary in main.
async function installGitLabChecksBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, fx) => {
    ipcMain.removeHandler('hostedReview:forBranch')
    ipcMain.handle('hostedReview:forBranch', async () => ({
      provider: 'gitlab',
      number: fx.mrNumber,
      title: 'Add purchase API component test coverage',
      state: 'open',
      url: fx.mrUrl,
      status: 'failure',
      updatedAt: '2026-07-07T12:00:00.000Z',
      mergeable: 'MERGEABLE',
      headSha: fx.headSha
    }))

    ipcMain.removeHandler('gitlab:workItemDetails')
    ipcMain.handle('gitlab:workItemDetails', async () => ({
      item: {
        id: `gitlab-mr-${fx.mrNumber}`,
        type: 'mr',
        number: fx.mrNumber,
        title: 'Add purchase API component test coverage',
        state: 'opened',
        url: fx.mrUrl,
        labels: [],
        updatedAt: '2026-07-07T12:00:00.000Z',
        author: 'e2e-bot'
      },
      body: 'Synthetic MR used for #7732 repro evidence.',
      comments: [],
      headSha: fx.headSha,
      pipelineJobs: [
        {
          id: fx.jobId,
          pipelineId: 55,
          name: fx.jobName,
          stage: fx.stage,
          status: 'failed',
          webUrl: fx.webUrl,
          duration: 87
        }
      ],
      reviewers: []
    }))

    ipcMain.removeHandler('gitlab:jobTrace')
    ;(globalThis as { __repro7732JobTraceCalls?: number }).__repro7732JobTraceCalls = 0
    ipcMain.handle('gitlab:jobTrace', async () => {
      const g = globalThis as { __repro7732JobTraceCalls?: number }
      g.__repro7732JobTraceCalls = (g.__repro7732JobTraceCalls ?? 0) + 1
      return { ok: true, trace: fx.trace }
    })
  }, FIXTURE)
}

async function readJobTraceCallCount(electronApp: ElectronApplication): Promise<number> {
  return electronApp.evaluate(
    () => (globalThis as { __repro7732JobTraceCalls?: number }).__repro7732JobTraceCalls ?? 0
  )
}

async function linkGitLabMRToWorktree(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(
    ({ worktreeId, mrNumber }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState((current) => ({
        worktreesByRepo: Object.fromEntries(
          Object.entries(current.worktreesByRepo).map(([repoId, worktrees]) => [
            repoId,
            worktrees.map((worktree) =>
              worktree.id === worktreeId ? { ...worktree, linkedGitLabMR: mrNumber } : worktree
            )
          ])
        ),
        gitStatusByWorktree: { ...current.gitStatusByWorktree, [worktreeId]: [] }
      }))
    },
    { worktreeId, mrNumber: FIXTURE.mrNumber }
  )
}

test.describe('#7732 GitLab Checks panel job details', () => {
  test('expanding a failed pipeline job shows its log, not "No inline details"', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installGitLabChecksBackend(electronApp)

    const worktreeId = await orcaPage.evaluate(
      () => window.__store?.getState().activeWorktreeId ?? null
    )
    if (!worktreeId) {
      throw new Error('E2E fixture did not expose an active worktree')
    }
    // Late startup UI hydration resets the active workspace + sidebar route; let it settle first.
    await orcaPage.waitForTimeout(8_000)

    const jobRow = orcaPage.getByText(`${FIXTURE.stage}: ${FIXTURE.jobName}`, { exact: true })
    for (let attempt = 0; attempt < 40 && (await jobRow.count()) === 0; attempt++) {
      await linkGitLabMRToWorktree(orcaPage, worktreeId)
      await openChecks(orcaPage, worktreeId)
      await orcaPage.waitForTimeout(500)
    }
    await expect(jobRow).toBeVisible({ timeout: 15_000 })

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await jobRow.click()
    const noDetails = orcaPage.getByText('No inline details are available for this check.')
    const viewFullLogs = orcaPage.getByRole('button', { name: 'View full logs' })
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await noDetails.count()) > 0 || (await viewFullLogs.count()) > 0) {
        break
      }
      await orcaPage.waitForTimeout(500)
    }
    await orcaPage.screenshot({
      path: path.join(SCREENSHOT_DIR, 'gitlab-checks-job-expanded.png')
    })

    // Correct behavior: the stubbed gitlab:jobTrace log renders instead of the "no details" fallback.
    expect(await readJobTraceCallCount(electronApp)).toBeGreaterThan(0)
    await expect(noDetails).toHaveCount(0)
    await expect(viewFullLogs).toBeVisible({ timeout: 10_000 })
  })
})
