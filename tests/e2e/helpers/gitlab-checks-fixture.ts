import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

/**
 * Synthetic GitLab MR + failed pipeline job used to drive the Checks panel
 * without a live GitLab project. All values are fake so evidence screenshots
 * carry no private data.
 */
export const GITLAB_CHECKS_FIXTURE = {
  mrNumber: 4242,
  jobId: 987654,
  jobName: 'Purchase API Component Tests',
  stage: 'Component Tests',
  webUrl: 'https://gitlab.example.test/acme/orca/-/jobs/987654',
  mrUrl: 'https://gitlab.example.test/acme/orca/-/merge_requests/4242',
  headSha: 'e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2e',
  trace: [
    '$ pnpm test:component --project purchase-api',
    'Running 128 component tests across 6 shards…',
    'PASS  src/purchase/cart.spec.ts (42 tests)',
    'PASS  src/purchase/checkout.spec.ts (37 tests)',
    'FAIL  src/purchase/refund.spec.ts',
    '  ● refund flow › issues a partial refund for a split payment',
    '    AssertionError: expected refunded amount 4200 to equal 4250',
    '      at Object.<anonymous> (src/purchase/refund.spec.ts:118:32)',
    'Tests: 1 failed, 127 passed, 128 total',
    'ERROR: Job failed: exit code 1'
  ].join('\n')
} as const

/**
 * Re-registers the GitLab + hosted-review IPC handlers in the main process so
 * the real renderer fetch path resolves to synthetic data. Returns nothing; the
 * handlers stay installed for the lifetime of the app instance.
 */
export async function installGitLabChecksBackend(
  electronApp: ElectronApplication,
  fixture: typeof GITLAB_CHECKS_FIXTURE = GITLAB_CHECKS_FIXTURE
): Promise<void> {
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
      body: 'Synthetic MR used for Checks panel evidence.',
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
    ipcMain.handle('gitlab:jobTrace', async () => ({ ok: true, trace: fx.trace }))
  }, fixture)
}

/**
 * Links the synthetic GitLab MR to the given worktree and clears its git status
 * so the Checks panel renders the review header + pipeline jobs.
 */
export async function linkGitLabMRToWorktree(
  page: Page,
  worktreeId: string,
  mrNumber: number
): Promise<void> {
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
        gitStatusByWorktree: {
          ...current.gitStatusByWorktree,
          [worktreeId]: []
        }
      }))
    },
    { worktreeId, mrNumber }
  )
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const worktrees = Object.values(window.__store?.getState().worktreesByRepo ?? {}).flat()
          return worktrees.find((entry) => entry.id === worktreeId)?.linkedGitLabMR ?? null
        }, worktreeId),
      { timeout: 5_000 }
    )
    .toBe(mrNumber)
}
