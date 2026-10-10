/**
 * E2E: viewing a GitLab merge request and exercising its review actions.
 *
 * All GitLab IPC is stubbed at the main-process boundary — contextIsolation makes
 * `window.api` non-writable, so handlers must be replaced via `ipcMain`. Every
 * mutation records its args on `globalThis` so the spec can assert what crossed
 * IPC; the user-facing assertions all read the rendered DOM.
 */

import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const MR_IID = 4242
const MR_TITLE = 'Add GitLab review coverage'
const NEW_MR_TITLE = 'Add GitLab review coverage (edited)'
const MR_BODY = 'Synthetic merge request body for the E2E review flow.'
const NEW_MR_BODY = 'Edited merge request body from the E2E review flow.'
const POSTED_COMMENT = 'Looks good to me.'
const THREAD_ID = 'discussion-9'

type StubReviewer = { id: number; username: string; name: string; avatarUrl: string }
type StubComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  threadId?: string
  isResolved?: boolean
}
type StubFile = {
  path: string
  status: string
  additions: number
  deletions: number
  isBinary: boolean
  diff: string
}
type StubMrItem = {
  id: string
  type: string
  number: number
  title: string
  state: string
  url: string
  labels: string[]
  updatedAt: string
  author: string
}

type MutationLog = {
  addMRComment: { iid: number; body: string; repoPath: string }[]
  updateMRReviewers: { iid: number; reviewerIds: number[] }[]
  updateMR: { iid: number; updates: { title?: string; body?: string } }[]
  mergeMR: { iid: number }[]
  resolveMRDiscussion: { iid: number; discussionId: string; resolved: boolean }[]
}

const REVIEWER: StubReviewer = {
  id: 42,
  username: 'reviewer-e2e',
  name: 'Reviewer E2E',
  avatarUrl: ''
}

const FIXTURE = {
  item: {
    id: 'mr-4242',
    type: 'mr',
    number: MR_IID,
    title: MR_TITLE,
    state: 'opened',
    url: 'https://gitlab.example.test/acme/orca/-/merge_requests/4242',
    labels: [],
    updatedAt: '2026-10-01T00:00:00.000Z',
    author: 'e2e-bot'
  } satisfies StubMrItem,
  body: MR_BODY,
  comments: [
    {
      id: 9001,
      author: 'reviewer-e2e',
      authorAvatarUrl: '',
      body: 'Please resolve this thread.',
      createdAt: '2026-10-01T01:00:00.000Z',
      url: 'https://gitlab.example.test/acme/orca/-/merge_requests/4242#note_9001',
      threadId: THREAD_ID,
      isResolved: false
    }
  ] satisfies StubComment[],
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      isBinary: false,
      diff: '@@ -1 +1 @@\n-const value = 0\n+const value = 1'
    }
  ] satisfies StubFile[],
  reviewerOptions: [REVIEWER] satisfies StubReviewer[],
  approvalState: {
    approvalsRequired: 1,
    approvalsLeft: 1,
    approvedBy: [] satisfies StubReviewer[],
    rules: []
  },
  headSha: 'head-sha',
  baseSha: 'base-sha',
  startSha: 'start-sha'
}

async function installGitLabMrBackend(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, fx) => {
    const item: StubMrItem = { ...fx.item }
    let body = fx.body
    const comments: StubComment[] = [...fx.comments]
    const files: StubFile[] = [...fx.files]
    // Why: start unassigned so the picker offers the reviewer as an addable option.
    let reviewers: StubReviewer[] = []
    const mutations: Record<string, unknown[]> = {
      addMRComment: [],
      updateMRReviewers: [],
      updateMR: [],
      mergeMR: [],
      resolveMRDiscussion: []
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spec-private main-process probe global; only this spec's stubs write and read it.
    const probe = globalThis as unknown as { __gitlabMrMutations?: Record<string, unknown[]> }
    probe.__gitlabMrMutations = mutations

    // Why: the GitLab source only appears when preflight reports a working glab.
    ipcMain.removeHandler('preflight:check')
    ipcMain.handle('preflight:check', () => ({
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true }
    }))

    ipcMain.removeHandler('gitlab:listMRs')
    ipcMain.handle('gitlab:listMRs', () => ({
      items: [item],
      page: 1,
      perPage: 50,
      totalCount: 1,
      totalPages: 1
    }))

    ipcMain.removeHandler('gitlab:listAssignableUsers')
    ipcMain.handle('gitlab:listAssignableUsers', () => fx.reviewerOptions)

    ipcMain.removeHandler('gitlab:listLabels')
    ipcMain.handle('gitlab:listLabels', () => [])

    ipcMain.removeHandler('gitlab:workItemDetails')
    ipcMain.handle('gitlab:workItemDetails', () => ({
      item,
      body,
      comments,
      files,
      reviewers,
      approvalState: fx.approvalState,
      headSha: fx.headSha,
      baseSha: fx.baseSha,
      startSha: fx.startSha
    }))

    ipcMain.removeHandler('gitlab:addMRComment')
    ipcMain.handle('gitlab:addMRComment', (_event, args) => {
      mutations.addMRComment.push(args)
      const comment: StubComment = {
        id: 9999,
        author: 'e2e-bot',
        authorAvatarUrl: '',
        body: args.body,
        createdAt: '2026-10-04T00:00:00.000Z',
        url: item.url
      }
      comments.push(comment)
      return { ok: true, comment }
    })

    ipcMain.removeHandler('gitlab:updateMRReviewers')
    ipcMain.handle('gitlab:updateMRReviewers', (_event, args) => {
      mutations.updateMRReviewers.push(args)
      reviewers = fx.reviewerOptions.filter((user) => args.reviewerIds.includes(user.id))
      return { ok: true, reviewers }
    })

    ipcMain.removeHandler('gitlab:updateMR')
    ipcMain.handle('gitlab:updateMR', (_event, args) => {
      mutations.updateMR.push(args)
      const updates = args.updates ?? {}
      if (typeof updates.title === 'string') {
        item.title = updates.title
      }
      if (typeof updates.body === 'string') {
        body = updates.body
      }
      return { ok: true }
    })

    ipcMain.removeHandler('gitlab:mergeMR')
    ipcMain.handle('gitlab:mergeMR', (_event, args) => {
      mutations.mergeMR.push(args)
      item.state = 'merged'
      return { ok: true }
    })

    ipcMain.removeHandler('gitlab:resolveMRDiscussion')
    ipcMain.handle('gitlab:resolveMRDiscussion', (_event, args) => {
      mutations.resolveMRDiscussion.push(args)
      const comment = comments.find((row) => row.threadId === args.discussionId)
      if (comment) {
        comment.isResolved = args.resolved
      }
      return { ok: true }
    })
  }, FIXTURE)
}

async function readMutationLog(electronApp: ElectronApplication): Promise<MutationLog> {
  return electronApp.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the spec-private main-process probe global its stubs wrote.
    const globals = globalThis as unknown as { __gitlabMrMutations?: MutationLog }
    const log = globals.__gitlabMrMutations
    return {
      addMRComment: log?.addMRComment ?? [],
      updateMRReviewers: log?.updateMRReviewers ?? [],
      updateMR: log?.updateMR ?? [],
      mergeMR: log?.mergeMR ?? [],
      resolveMRDiscussion: log?.resolveMRDiscussion ?? []
    }
  })
}

/** Point the Tasks page at the stubbed GitLab backend and open it. */
async function openGitLabTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettings({ uiLanguage: 'en' })
    const state = store.getState()
    // Why: the GitLab list only fetches for task-eligible repos with a settled remote identity.
    store.setState({
      repos: state.repos.map((repo) => ({
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.example.test/acme/orca',
          remoteName: 'origin',
          remoteUrl: 'https://gitlab.example.test/acme/orca.git'
        }
      }))
    })
    await store.getState().refreshPreflightStatus({ force: true })
    store.getState().openTaskPage({ taskSource: 'gitlab' })
  })
}

/** Click the stubbed MR row and return its open detail sheet. */
async function openMrDetail(page: Page): Promise<Locator> {
  const row = page.getByText(MR_TITLE, { exact: true })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const dialog = page.getByRole('dialog')
  // Target the visible heading; the accessible SheetTitle is a hidden duplicate.
  await expect(dialog.locator('h2.text-lg')).toHaveText(MR_TITLE, { timeout: 10_000 })
  return dialog
}

async function openAndReachDetail(electronApp: ElectronApplication, page: Page): Promise<Locator> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await installGitLabMrBackend(electronApp)
  await openGitLabTasks(page)
  return openMrDetail(page)
}

test.describe('GitLab merge request review', () => {
  test('renders the MR detail with state, description, and Files/Conversation surfaces', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openAndReachDetail(electronApp, orcaPage)

    await expect(dialog.getByText(`!${MR_IID}`, { exact: true })).toBeVisible()
    await expect(dialog.locator('h2.text-lg')).toHaveText(MR_TITLE)
    await expect(dialog.getByText('opened', { exact: true })).toBeVisible()
    await expect(dialog.getByText(MR_BODY, { exact: false })).toBeVisible()
    await expect(dialog.getByRole('tab', { name: /^Conversation/ })).toBeVisible()
    await expect(dialog.getByRole('tab', { name: /^Files/ })).toBeVisible()

    await dialog.getByRole('tab', { name: /^Files/ }).click()
    await expect(dialog.locator('pre').first()).toContainText('const value = 1')
  })

  test('posting a comment calls addMRComment with the typed body and renders it', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openAndReachDetail(electronApp, orcaPage)

    await dialog.locator('textarea').first().fill(POSTED_COMMENT)
    await dialog.getByRole('button', { name: 'Comment', exact: true }).click()
    await dialog.getByRole('tab', { name: /^Conversation/ }).click()
    await expect(dialog.getByText(POSTED_COMMENT, { exact: true })).toBeVisible()

    const log = await readMutationLog(electronApp)
    expect(log.addMRComment).toHaveLength(1)
    expect(log.addMRComment[0]).toMatchObject({ iid: MR_IID, body: POSTED_COMMENT })
    expect(typeof log.addMRComment[0].repoPath).toBe('string')
  })

  test('adding a reviewer calls updateMRReviewers and renders the reviewer', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openAndReachDetail(electronApp, orcaPage)

    await dialog.getByRole('button', { name: 'Manage' }).click()
    const select = dialog.locator('select')
    await expect(select.locator(`option[value="id:${REVIEWER.id}"]`)).toHaveCount(1)
    await select.selectOption(`id:${REVIEWER.id}`)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog.getByText(REVIEWER.username, { exact: true })).toBeVisible()

    const log = await readMutationLog(electronApp)
    expect(log.updateMRReviewers).toHaveLength(1)
    expect(log.updateMRReviewers[0]).toMatchObject({ iid: MR_IID, reviewerIds: [REVIEWER.id] })
  })

  test('saving MR edits calls updateMR and updates the rendered title and body', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openAndReachDetail(electronApp, orcaPage)
    const title = dialog.locator('h2.text-lg')
    await expect(title).toHaveText(MR_TITLE)

    await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
    const panel = dialog.getByRole('tabpanel')
    await panel.locator('input').first().fill(NEW_MR_TITLE)
    await panel.locator('textarea').first().fill(NEW_MR_BODY)
    await panel.getByRole('button', { name: 'Save' }).click()

    await expect(title).toHaveText(NEW_MR_TITLE)
    await expect(dialog.getByText(NEW_MR_BODY, { exact: true })).toBeVisible()

    const log = await readMutationLog(electronApp)
    expect(log.updateMR).toHaveLength(1)
    expect(log.updateMR[0]).toMatchObject({
      iid: MR_IID,
      updates: { title: NEW_MR_TITLE, body: NEW_MR_BODY }
    })
  })

  test('merging an MR calls mergeMR and confirms the merged MR', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openAndReachDetail(electronApp, orcaPage)

    const mergeButton = dialog.getByRole('button', { name: 'Merge', exact: true })
    await expect(mergeButton).toBeVisible()
    await mergeButton.click()

    await expect(orcaPage.getByText(`Merged MR !${MR_IID}`, { exact: false })).toBeVisible({
      timeout: 10_000
    })

    const log = await readMutationLog(electronApp)
    expect(log.mergeMR).toHaveLength(1)
    expect(log.mergeMR[0]).toMatchObject({ iid: MR_IID })
  })

  test('resolving a discussion calls resolveMRDiscussion and updates the thread UI', async ({
    electronApp,
    orcaPage
  }) => {
    const dialog = await openAndReachDetail(electronApp, orcaPage)

    await dialog.getByRole('tab', { name: /^Conversation/ }).click()
    const resolveButton = dialog.getByRole('button', { name: 'Resolve', exact: true })
    await expect(resolveButton).toBeVisible()
    await resolveButton.click()

    await expect(dialog.getByText('resolved', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible()

    const log = await readMutationLog(electronApp)
    expect(log.resolveMRDiscussion).toHaveLength(1)
    expect(log.resolveMRDiscussion[0]).toMatchObject({
      iid: MR_IID,
      discussionId: THREAD_ID,
      resolved: true
    })
  })
})
