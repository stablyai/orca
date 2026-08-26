import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import type { GitHubWorkItem } from '../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../src/shared/gitlab-types'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const TARGET_URL = 'https://github.com/stablyai/orca/issues/4242'
const WRONG_TITLE = 'Wrong cached issue'
const TARGET_TITLE = 'Exact pasted issue'
const GITLAB_TARGET_URL = 'https://gitlab.example.test/stablyai/orca/-/merge_requests/4242'
const GITLAB_WRONG_TITLE = 'Wrong cached merge request'
const GITLAB_TARGET_TITLE = 'Exact pasted merge request'
const MIN_PASTED_FRAMES = 2
const TRANSITION_FRAME_LIMIT = 600

const WRONG_ITEM: GitHubWorkItem = {
  id: 'issue-17',
  type: 'issue',
  number: 17,
  title: WRONG_TITLE,
  state: 'open',
  url: 'https://github.com/stablyai/orca/issues/17',
  labels: [],
  updatedAt: '2026-08-01T00:00:00.000Z',
  author: 'e2e',
  repoId: 'e2e-repo'
}

const TARGET_ITEM: GitHubWorkItem = {
  ...WRONG_ITEM,
  id: 'issue-4242',
  number: 4242,
  title: TARGET_TITLE,
  url: TARGET_URL,
  updatedAt: '2026-08-02T00:00:00.000Z'
}

const GITLAB_WRONG_ITEM: GitLabWorkItem = {
  id: 'mr-17',
  type: 'mr',
  number: 17,
  title: GITLAB_WRONG_TITLE,
  state: 'opened',
  url: 'https://gitlab.example.test/stablyai/orca/-/merge_requests/17',
  labels: [],
  updatedAt: '2026-08-01T00:00:00.000Z',
  author: 'e2e',
  repoId: 'e2e-repo'
}

const GITLAB_TARGET_ITEM: GitLabWorkItem = {
  ...GITLAB_WRONG_ITEM,
  id: 'mr-4242',
  number: 4242,
  title: GITLAB_TARGET_TITLE,
  url: GITLAB_TARGET_URL,
  updatedAt: '2026-08-02T00:00:00.000Z'
}

type TransitionFrame = {
  value: string
  wrongVisible: boolean
  wrongSelected: boolean
  targetVisible: boolean
  targetSelected: boolean
}

function pasteChord(): string {
  return process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
}

async function startTransitionCapture(
  page: Page,
  frameKey: string,
  wrongTitle: string,
  targetTitle: string
): Promise<void> {
  await page.evaluate(
    ({ frameKey, frameLimit, wrongTitle, targetTitle }) => {
      const frames: TransitionFrame[] = []
      const capture = (): void => {
        const input = document.querySelector<HTMLInputElement>('[data-workspace-name-input="true"]')
        const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        const wrong = options.find((option) => option.textContent?.includes(wrongTitle))
        const target = options.find((option) => option.textContent?.includes(targetTitle))
        frames.push({
          value: input?.value ?? '',
          wrongVisible: Boolean(wrong && wrong.getClientRects().length > 0),
          wrongSelected: wrong?.dataset.selected === 'true',
          targetVisible: Boolean(target && target.getClientRects().length > 0),
          targetSelected: target?.dataset.selected === 'true'
        })
        if (frames.length < frameLimit) {
          requestAnimationFrame(capture)
        }
      }
      Reflect.set(window, frameKey, frames)
      capture()
    },
    { frameKey, frameLimit: TRANSITION_FRAME_LIMIT, wrongTitle, targetTitle }
  )
}

async function readTransitionFrames(page: Page, frameKey: string): Promise<TransitionFrame[]> {
  return page.evaluate((key) => Reflect.get(window, key) as TransitionFrame[], frameKey)
}

async function expectLookupHeldWithoutStaleRow(
  page: Page,
  frameKey: string,
  targetUrl: string,
  wrongOption: Locator,
  targetOption: Locator
): Promise<void> {
  await expect
    .poll(async () => {
      const frames = await readTransitionFrames(page, frameKey)
      return frames.filter((frame) => frame.value === targetUrl).length
    })
    .toBeGreaterThanOrEqual(MIN_PASTED_FRAMES)
  await expect(wrongOption).toHaveCount(0)
  await expect(targetOption).toHaveCount(0)
}

async function expectExactTargetAfterLookup(
  page: Page,
  frameKey: string,
  targetUrl: string,
  targetOption: Locator
): Promise<void> {
  await expect(targetOption).toBeVisible()
  await expect(targetOption).toHaveAttribute('data-selected', 'true')
  await expect
    .poll(async () => {
      const frames = await readTransitionFrames(page, frameKey)
      return frames.some((frame) => frame.targetVisible && frame.targetSelected)
    })
    .toBe(true)

  const frames = await readTransitionFrames(page, frameKey)
  const pastedFrames = frames.filter((frame) => frame.value === targetUrl)
  expect(frames.some((frame) => frame.wrongVisible)).toBe(true)
  expect(pastedFrames.length).toBeGreaterThanOrEqual(MIN_PASTED_FRAMES)
  expect(pastedFrames.every((frame) => !frame.wrongVisible && !frame.wrongSelected)).toBe(true)
  expect(pastedFrames.some((frame) => frame.targetVisible && frame.targetSelected)).toBe(true)
}

async function installHeldGitHubLookup(
  electronApp: ElectronApplication,
  page: Page
): Promise<void> {
  await electronApp.evaluate(({ ipcMain }, targetItem) => {
    const fixture = globalThis as unknown as {
      __githubUrlLookupStarted?: boolean
      __releaseGitHubUrlLookup?: () => void
    }
    fixture.__githubUrlLookupStarted = false
    ipcMain.removeHandler('gh:repoSlug')
    ipcMain.handle('gh:repoSlug', () => ({ owner: 'stablyai', repo: 'orca' }))
    ipcMain.removeHandler('gh:workItemByOwnerRepo')
    ipcMain.handle('gh:workItemByOwnerRepo', () => {
      fixture.__githubUrlLookupStarted = true
      return new Promise((resolve) => {
        fixture.__releaseGitHubUrlLookup = () => resolve(targetItem)
      })
    })
  }, TARGET_ITEM)
  await page.evaluate((wrongItem) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.setState({
      getCachedWorkItems: () => [wrongItem],
      fetchWorkItems: async () => [wrongItem],
      fetchWorkItemsAcrossRepos: async () => ({
        items: [wrongItem],
        failedCount: 0,
        githubUnavailable: false
      })
    })
  }, WRONG_ITEM)
}

async function releaseGitHubLookup(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const fixture = globalThis as unknown as { __releaseGitHubUrlLookup?: () => void }
    if (!fixture.__releaseGitHubUrlLookup) {
      throw new Error('GitHub lookup is not held')
    }
    fixture.__releaseGitHubUrlLookup()
  })
}

async function installHeldGitLabLookup(
  electronApp: ElectronApplication,
  page: Page
): Promise<void> {
  await electronApp.evaluate(
    ({ ipcMain }, { wrongItem, targetItem }) => {
      const fixture = globalThis as unknown as {
        __gitlabUrlLookupStarted?: boolean
        __releaseGitLabUrlLookup?: () => void
      }
      fixture.__gitlabUrlLookupStarted = false
      ipcMain.removeHandler('gitlab:listMRs')
      ipcMain.handle('gitlab:listMRs', () => ({
        items: [wrongItem],
        page: 1,
        perPage: 12,
        totalCount: 1,
        totalPages: 1
      }))
      ipcMain.removeHandler('gitlab:workItemByPath')
      ipcMain.handle('gitlab:workItemByPath', () => {
        fixture.__gitlabUrlLookupStarted = true
        return new Promise((resolve) => {
          fixture.__releaseGitLabUrlLookup = () => resolve(targetItem)
        })
      })
    },
    { wrongItem: GITLAB_WRONG_ITEM, targetItem: GITLAB_TARGET_ITEM }
  )
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    if (!state.preflightStatusContextKey) {
      throw new Error('preflight context is not ready')
    }
    store.setState({
      preflightStatus: {
        git: state.preflightStatus?.git ?? { installed: true },
        gh: state.preflightStatus?.gh ?? { installed: true, authenticated: true },
        glab: { installed: true, authenticated: true }
      },
      preflightStatusChecked: true
    })
  })
}

async function releaseGitLabLookup(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const fixture = globalThis as unknown as { __releaseGitLabUrlLookup?: () => void }
    if (!fixture.__releaseGitLabUrlLookup) {
      throw new Error('GitLab lookup is not held')
    }
    fixture.__releaseGitLabUrlLookup()
  })
}

test('a pasted GitHub URL never selects a stale cached issue', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await installHeldGitHubLookup(electronApp, orcaPage)

  await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  const input = dialog.locator('[data-workspace-name-input="true"]')
  await expect(input).toBeVisible()
  await input.click()

  const wrongOption = orcaPage.getByRole('option', { name: `#17 ${WRONG_TITLE}`, exact: true })
  const targetOption = orcaPage.getByRole('option', {
    name: `#4242 ${TARGET_TITLE}`,
    exact: true
  })
  await expect(wrongOption).toBeVisible()

  const frameKey = '__githubUrlTransitionFrames'
  await startTransitionCapture(orcaPage, frameKey, WRONG_TITLE, TARGET_TITLE)

  await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), TARGET_URL)
  await input.focus()
  await orcaPage.keyboard.press(pasteChord())
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const fixture = globalThis as unknown as { __githubUrlLookupStarted?: boolean }
        return fixture.__githubUrlLookupStarted === true
      })
    )
    .toBe(true)
  await expectLookupHeldWithoutStaleRow(orcaPage, frameKey, TARGET_URL, wrongOption, targetOption)

  await releaseGitHubLookup(electronApp)
  await expectExactTargetAfterLookup(orcaPage, frameKey, TARGET_URL, targetOption)

  await testInfo.attach('github-url-smart-input-fixed.png', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
})

test('a pasted GitLab URL never selects a stale cached merge request', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await installHeldGitLabLookup(electronApp, orcaPage)

  await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  const input = dialog.locator('[data-workspace-name-input="true"]')
  await expect(input).toBeVisible()
  await input.click()

  const wrongOption = orcaPage.getByRole('option', {
    name: `!17 ${GITLAB_WRONG_TITLE}`,
    exact: true
  })
  const targetOption = orcaPage.getByRole('option', {
    name: `!4242 ${GITLAB_TARGET_TITLE}`,
    exact: true
  })
  await expect(wrongOption).toBeVisible()

  const frameKey = '__gitlabUrlTransitionFrames'
  await startTransitionCapture(orcaPage, frameKey, GITLAB_WRONG_TITLE, GITLAB_TARGET_TITLE)

  await orcaPage.evaluate((text) => window.api.ui.writeClipboardText(text), GITLAB_TARGET_URL)
  await input.focus()
  await orcaPage.keyboard.press(pasteChord())
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const fixture = globalThis as unknown as { __gitlabUrlLookupStarted?: boolean }
        return fixture.__gitlabUrlLookupStarted === true
      })
    )
    .toBe(true)
  await expectLookupHeldWithoutStaleRow(
    orcaPage,
    frameKey,
    GITLAB_TARGET_URL,
    wrongOption,
    targetOption
  )

  await releaseGitLabLookup(electronApp)
  await expectExactTargetAfterLookup(orcaPage, frameKey, GITLAB_TARGET_URL, targetOption)

  await testInfo.attach('gitlab-url-smart-input-fixed.png', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
})
