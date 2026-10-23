/**
 * E2E coverage for the GitLab source of the Tasks page.
 *
 * GitLab had almost no E2E coverage; this drives the real renderer against
 * synthetic main-process IPC stubs: list chrome + issue rows, the MR detail
 * sheet, filter re-querying, issue description/comments, and the MR pipeline
 * jobs tab. Assertions are DOM-only.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { GitLabWorkItem, GitLabWorkItemDetails } from '../../src/shared/gitlab-types'

type GitLabTaskCall = {
  channel: string
  state?: string
  assignee?: string
  query?: string
  page?: number
  perPage?: number
}

type GitLabCallLog = { __gitlabTaskCalls?: GitLabTaskCall[] }

// Why: the seeded repo has no remote; stamp a GitLab remote so it stays an
// eligible Tasks project and the GitLab source has a repo to fetch against.
const GITLAB_REMOTE = {
  canonicalKey: 'gitlab.example.test/acme/orca',
  remoteName: 'origin',
  remoteUrl: 'https://gitlab.example.test/acme/orca.git'
}

const PREFLIGHT = {
  git: { installed: true },
  gh: { installed: true, authenticated: true },
  glab: { installed: true, authenticated: true }
}

const ISSUE: GitLabWorkItem = {
  id: 'gitlab-issue-101',
  type: 'issue',
  number: 101,
  title: 'Kubernetes runner drops the cache mount',
  state: 'opened',
  url: 'https://gitlab.example.test/acme/orca/-/issues/101',
  labels: ['bug'],
  updatedAt: '2026-09-20T10:00:00.000Z',
  author: 'e2e-issue-author',
  repoId: 'e2e-gitlab-repo'
}

const ASSIGNED_ISSUE: GitLabWorkItem = {
  ...ISSUE,
  id: 'gitlab-issue-202',
  number: 202,
  title: 'Only the assigned-to-me issue'
}

const MR: GitLabWorkItem = {
  id: 'gitlab-mr-77',
  type: 'mr',
  number: 77,
  title: 'Add GitLab task list coverage',
  state: 'opened',
  url: 'https://gitlab.example.test/acme/orca/-/merge_requests/77',
  labels: ['e2e'],
  updatedAt: '2026-09-25T12:00:00.000Z',
  author: 'e2e-mr-author',
  branchName: 'feat/gitlab-task-lists',
  baseRefName: 'main',
  repoId: 'e2e-gitlab-repo'
}

// Why: the detail sheet renders description markdown, not the branch fields, so
// the stub body carries the source/target branch names the flow asserts on.
const MR_BODY = [
  'Synthetic MR used by the GitLab Tasks page spec.',
  '',
  'Source branch: `feat/gitlab-task-lists`',
  'Target branch: `main`'
].join('\n')

const MR_DETAILS: GitLabWorkItemDetails = {
  item: {
    id: MR.id,
    type: 'mr',
    number: MR.number,
    title: MR.title,
    state: 'opened',
    url: MR.url,
    labels: MR.labels,
    updatedAt: MR.updatedAt,
    author: MR.author
  },
  body: MR_BODY,
  comments: [
    {
      id: 1,
      author: 'e2e-mr-reviewer',
      authorAvatarUrl: '',
      body: 'Pipeline is red on the runner job.',
      createdAt: '2026-09-25T13:00:00.000Z',
      url: 'https://gitlab.example.test/acme/orca/-/merge_requests/77#note_1'
    }
  ],
  headSha: 'e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2e',
  pipelineJobs: [
    {
      id: 987654,
      pipelineId: 55,
      name: 'unit-tests',
      stage: 'test',
      status: 'failed',
      webUrl: 'https://gitlab.example.test/acme/orca/-/jobs/987654',
      duration: 87
    }
  ],
  reviewers: []
}

const ISSUE_DETAILS: GitLabWorkItemDetails = {
  item: {
    id: ISSUE.id,
    type: 'issue',
    number: ISSUE.number,
    title: ISSUE.title,
    state: 'opened',
    url: ISSUE.url,
    labels: ISSUE.labels,
    updatedAt: ISSUE.updatedAt,
    author: ISSUE.author
  },
  body: 'The Kubernetes runner loses /cache between jobs.',
  comments: [
    {
      id: 2,
      author: 'e2e-commenter',
      authorAvatarUrl: '',
      body: 'Reproduced on the shared runner.',
      createdAt: '2026-09-21T09:00:00.000Z',
      url: 'https://gitlab.example.test/acme/orca/-/issues/101#note_2'
    }
  ]
}

const JOB_TRACE = [
  '$ pnpm test:unit',
  'FAIL src/runner.spec.ts',
  'ERROR: Job failed: exit code 1'
].join('\n')

async function installGitLabTaskBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(
    ({ ipcMain }, fx) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spec-private main-process call log shared with this spec's IPC stubs.
      const g = globalThis as unknown as GitLabCallLog
      const calls: GitLabTaskCall[] = []
      g.__gitlabTaskCalls = calls
      const record = (call: GitLabTaskCall): void => {
        calls.push(call)
      }

      ipcMain.removeHandler('preflight:check')
      ipcMain.handle('preflight:check', async () => fx.preflight)

      ipcMain.removeHandler('gitlab:todos')
      ipcMain.handle('gitlab:todos', async () => [])

      ipcMain.removeHandler('gitlab:listIssues')
      ipcMain.handle('gitlab:listIssues', async (_event, args) => {
        record({
          channel: 'gitlab:listIssues',
          state: args?.state,
          assignee: args?.assignee,
          page: args?.page
        })
        return {
          items: args?.assignee === '@me' ? fx.assignedIssues : fx.issues,
          totalPages: 1
        }
      })

      ipcMain.removeHandler('gitlab:listMRs')
      ipcMain.handle('gitlab:listMRs', async (_event, args) => {
        record({
          channel: 'gitlab:listMRs',
          state: args?.state,
          query: args?.query,
          page: args?.page,
          perPage: args?.perPage
        })
        return {
          items: fx.mrs,
          page: 1,
          perPage: args?.perPage ?? 50,
          totalCount: fx.mrs.length,
          totalPages: 1
        }
      })

      ipcMain.removeHandler('gitlab:workItemDetails')
      ipcMain.handle('gitlab:workItemDetails', async (_event, args) => {
        record({ channel: 'gitlab:workItemDetails' })
        return args?.type === 'issue' ? fx.issueDetails : fx.mrDetails
      })

      ipcMain.removeHandler('gitlab:jobTrace')
      ipcMain.handle('gitlab:jobTrace', async () => {
        record({ channel: 'gitlab:jobTrace' })
        return { ok: true, trace: fx.jobTrace }
      })
    },
    {
      preflight: PREFLIGHT,
      issues: [ISSUE],
      assignedIssues: [ASSIGNED_ISSUE],
      mrs: [MR],
      issueDetails: ISSUE_DETAILS,
      mrDetails: MR_DETAILS,
      jobTrace: JOB_TRACE
    }
  )
}

async function readGitLabCalls(electronApp: ElectronApplication): Promise<GitLabTaskCall[]> {
  return electronApp.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the spec-private main-process call log its IPC stubs wrote.
    const g = globalThis as unknown as GitLabCallLog
    return g.__gitlabTaskCalls ?? []
  })
}

async function enableGitLabTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
  })
  await page.evaluate(() => window.__store?.getState().refreshPreflightStatus({ force: true }))
  await expect
    .poll(() =>
      page.evaluate(() => window.__store?.getState().preflightStatus?.glab?.installed === true)
    )
    .toBe(true)
}

async function openGitLabTasks(page: Page): Promise<void> {
  await page.evaluate((identity) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const repo = state.repos[0]
    if (!repo) {
      throw new Error('E2E fixture did not expose a seeded repo')
    }
    store.setState({
      repos: state.repos.map((candidate) => ({ ...candidate, gitRemoteIdentity: identity }))
    })
    store.getState().openTaskPage({ taskSource: 'gitlab', preselectedRepoId: repo.id })
  }, GITLAB_REMOTE)

  await expect(page.getByRole('button', { name: 'Close tasks' })).toBeVisible({
    timeout: 15_000
  })
  // Why: the chip only renders when GitLab is an available source, so this
  // outlasts the preflight -> provider-visibility propagation.
  await expect(page.locator('[data-task-source="gitlab"]')).toBeVisible()
}

async function selectGitLabView(page: Page, view: 'Issues' | 'MRs'): Promise<void> {
  const button = page.getByRole('button', { name: view, exact: true })
  await expect(button).toBeVisible()
  await button.click()
}

test.describe('GitLab Tasks page', () => {
  test.beforeEach(async ({ electronApp, orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installGitLabTaskBackend(electronApp)
    await enableGitLabTasks(orcaPage)
  })

  test('renders the GitLab list chrome and issue rows from the stub', async ({ orcaPage }) => {
    await openGitLabTasks(orcaPage)
    await selectGitLabView(orcaPage, 'Issues')

    await expect(orcaPage.getByText(ISSUE.title, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(orcaPage.getByText(`#${ISSUE.number}`, { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Type / State', { exact: true })).toBeVisible()

    const sourceChip = orcaPage.locator('[data-task-source="gitlab"]')
    await expect(sourceChip).toHaveAttribute('aria-pressed', 'true')
    await expect(
      orcaPage.getByRole('button', {
        name: 'Refresh GitLab work items',
        exact: true
      })
    ).toBeVisible()
  })

  test('MR view rows open a detail sheet with the title and seeded branches', async ({
    orcaPage
  }) => {
    await openGitLabTasks(orcaPage)
    await selectGitLabView(orcaPage, 'MRs')

    const mrRow = orcaPage.getByText(MR.title, { exact: true })
    await expect(mrRow).toBeVisible({ timeout: 15_000 })
    await expect(orcaPage.getByText(`!${MR.number}`, { exact: true })).toBeVisible()

    await mrRow.click()

    const sheet = orcaPage.locator('[data-slot="sheet-content"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('header h2')).toHaveText(MR.title)
    // Why: the tab label carries a job-count badge, so match the name substring.
    await expect(sheet.getByRole('tab', { name: 'Pipeline' })).toBeVisible()
    await expect(sheet.getByText('feat/gitlab-task-lists', { exact: true })).toBeVisible()
    await expect(sheet.getByText('main', { exact: true })).toBeVisible()
  })

  test('filtering issues re-queries the backend with the assignee arg', async ({
    orcaPage,
    electronApp
  }) => {
    await openGitLabTasks(orcaPage)
    await selectGitLabView(orcaPage, 'Issues')
    await expect(orcaPage.getByText(ISSUE.title, { exact: true })).toBeVisible({
      timeout: 15_000
    })

    const presets = orcaPage.locator('[data-contextual-tour-target="tasks-search-presets"]')
    await presets.getByRole('button', { name: 'Assigned to me', exact: true }).click()

    await expect
      .poll(async () => {
        const calls = await readGitLabCalls(electronApp)
        return calls
          .filter((call) => call.channel === 'gitlab:listIssues')
          .map((call) => call.assignee ?? null)
      })
      .toContain('@me')

    await expect(orcaPage.getByText(ASSIGNED_ISSUE.title, { exact: true })).toBeVisible()
    await expect(orcaPage.getByText(ISSUE.title, { exact: true })).toHaveCount(0)
  })

  test('opening an issue shows its description and comments', async ({ orcaPage }) => {
    await openGitLabTasks(orcaPage)
    await selectGitLabView(orcaPage, 'Issues')

    const issueRow = orcaPage.getByText(ISSUE.title, { exact: true })
    await expect(issueRow).toBeVisible({ timeout: 15_000 })
    await issueRow.click()

    const sheet = orcaPage.locator('[data-slot="sheet-content"]')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('header h2')).toHaveText(ISSUE.title)
    await expect(sheet.getByText(ISSUE_DETAILS.body, { exact: true })).toBeVisible()

    await sheet.getByRole('tab', { name: 'Conversation' }).click()
    await expect(sheet.getByText('e2e-commenter', { exact: true })).toBeVisible()
    await expect(sheet.getByText('Reproduced on the shared runner.', { exact: true })).toBeVisible()
  })

  test('MR pipeline tab renders job rows and loads the job trace', async ({
    orcaPage,
    electronApp
  }) => {
    await openGitLabTasks(orcaPage)
    await selectGitLabView(orcaPage, 'MRs')

    const mrRow = orcaPage.getByText(MR.title, { exact: true })
    await expect(mrRow).toBeVisible({ timeout: 15_000 })
    await mrRow.click()

    const sheet = orcaPage.locator('[data-slot="sheet-content"]')
    await expect(sheet).toBeVisible()
    await sheet.getByRole('tab', { name: 'Pipeline' }).click()

    const jobRow = sheet.getByRole('button', {
      name: 'unit-tests',
      exact: true
    })
    await expect(jobRow).toBeVisible()
    await jobRow.click()

    await expect(sheet.getByText('ERROR: Job failed: exit code 1')).toBeVisible()
    await expect
      .poll(async () => {
        const calls = await readGitLabCalls(electronApp)
        return calls.some((call) => call.channel === 'gitlab:jobTrace')
      })
      .toBe(true)
  })
})
