import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { evaluatePolled } from './helpers/page-evaluate-polled'
import { addRepoWithWorkspaces, writeWorkspaceMeta } from './helpers/repo-with-workspaces'
import { waitForSessionReady } from './helpers/store'

const TARGET_INDEX = 24
const SYNTHETIC_COUNT = 40
const VISUAL_PROOF_PAUSE_MS = 1_200
const POST_REMOVAL_SAMPLE_FRAMES = 20
// A real delete runs git, so wait by time: a frame count shrinks on high-refresh displays.
const MAX_REMOVAL_WAIT_MS = 20_000

test.use({ seedTestRepo: false })

type RowRemovalFrame = {
  animationCount: number
  belowTop: number | null
  scrollTop: number
  targetExists: boolean
}

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    // Frame sampling started in the page and awaited once the removal animation settles.
    __activeDeleteRowRemovalFrames?: Promise<RowRemovalFrame[]>
  }
}

async function pauseForVisualProof(page: Page): Promise<void> {
  if (process.env.ORCA_E2E_RECORD_VIDEO === '1') {
    await page.waitForTimeout(VISUAL_PROOF_PAUSE_MS)
  }
}

async function seedActiveDeletionRows(
  page: Page,
  testInfo: TestInfo
): Promise<{
  belowId: string
  successorId: string
  targetId: string
}> {
  const repo = await addRepoWithWorkspaces(page, testInfo, SYNTHETIC_COUNT)
  await writeWorkspaceMeta(
    page,
    repo.ids.map((worktreeId, index) => ({
      worktreeId,
      updates: {
        displayName: `Active delete row ${String(index).padStart(2, '0')}`,
        sortOrder: SYNTHETIC_COUNT - index,
        manualOrder: SYNTHETIC_COUNT - index
      }
    }))
  )
  const targetId = repo.ids[TARGET_INDEX]!
  const belowId = repo.ids[TARGET_INDEX + 1]!
  const successorId = repo.ids[0]!
  await evaluatePolled(
    page,
    async ({ repoId, targetId, successorId }) => {
      const store = window.__store!
      const state = store.getState()
      await state.updateSettings({ skipDeleteWorktreeConfirm: true })
      // A setup script keeps the setup guide from opening over the sidebar.
      await state.updateRepo(repoId, {
        hookSettings: { mode: 'auto', scripts: { setup: 'true', archive: '' } }
      })
      store.setState({
        activeRepoId: repoId,
        activeView: 'terminal',
        activeWorktreeId: targetId,
        activeWorkspaceKey: `worktree:${targetId}`,
        filterRepoIds: [],
        groupBy: 'none',
        hideDefaultBranchWorkspace: false,
        lastVisitedAtByWorktreeId: { [successorId]: Date.now() + 1_000 },
        pendingRevealSidebarRow: null,
        pendingRevealWorktree: null,
        setupScriptPromptDismissedRepoIds: [`generation-v1:local\0${repoId}`],
        showActiveOnly: false,
        showSleepingWorkspaces: true,
        sidebarOpen: true,
        sortBy: 'manual'
      })
    },
    { repoId: repo.repoId, targetId, successorId }
  )
  return { belowId, successorId, targetId }
}

async function prepareScrolledActiveRow(page: Page, targetId: string): Promise<void> {
  const target = page.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
  )
  const scroller = page.locator('[data-worktree-sidebar]')
  await expect
    .poll(async () => {
      if ((await target.count()) > 0) {
        return true
      }
      await scroller.evaluate((element) => {
        element.scrollTop = Math.min(
          element.scrollHeight,
          element.scrollTop + Math.max(100, element.clientHeight / 2)
        )
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
      return false
    })
    .toBe(true)
  await target.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')
    if (!scroller) {
      throw new Error('Worktree sidebar is unavailable')
    }
    const targetOffset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += targetOffset - 160
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect(target).toBeVisible()
  await expect(target).toHaveAttribute('aria-current', 'page')
}

async function startRowRemovalSampling(
  page: Page,
  targetId: string,
  belowId: string
): Promise<void> {
  await page.evaluate(
    ({ belowId, maxRemovalWaitMs, postRemovalSampleFrames, targetId }) => {
      const sample = async (): Promise<RowRemovalFrame[]> => {
        const readFrame = (): RowRemovalFrame => {
          const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
          const below = document.querySelector<HTMLElement>(
            `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(belowId)}]`
          )
          const targetExists = Boolean(
            document.querySelector(
              `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
            )
          )
          return {
            animationCount:
              below?.closest('[data-worktree-virtual-row]')?.firstElementChild?.getAnimations()
                .length ?? 0,
            belowTop: below?.getBoundingClientRect().top ?? null,
            scrollTop: scroller?.scrollTop ?? 0,
            targetExists
          }
        }
        const frames: RowRemovalFrame[] = [readFrame()]
        let framesAfterRemoval = 0
        const deadline = performance.now() + maxRemovalWaitMs
        while (performance.now() < deadline) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const frame = readFrame()
          frames.push(frame)
          framesAfterRemoval = frame.targetExists ? 0 : framesAfterRemoval + 1
          if (framesAfterRemoval >= postRemovalSampleFrames) {
            break
          }
        }
        return frames
      }
      Reflect.set(window, '__activeDeleteRowRemovalFrames', sample())
    },
    {
      belowId,
      maxRemovalWaitMs: MAX_REMOVAL_WAIT_MS,
      postRemovalSampleFrames: POST_REMOVAL_SAMPLE_FRAMES,
      targetId
    }
  )
}

async function finishRowRemovalSampling(page: Page): Promise<RowRemovalFrame[]> {
  return page.evaluate(async () => {
    const pending = window.__activeDeleteRowRemovalFrames
    if (!(pending instanceof Promise)) {
      throw new Error('Row removal sampling was not started')
    }
    return pending
  })
}

test('deleting the active scrolled worktree preserves position and closes the row gap', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1_200, height: 800 })
  const { belowId, successorId, targetId } = await seedActiveDeletionRows(orcaPage, testInfo)
  await prepareScrolledActiveRow(orcaPage, targetId)
  const target = orcaPage.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(targetId)}]`
  )
  const below = orcaPage.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(belowId)}]`
  )
  await pauseForVisualProof(orcaPage)
  const contextMenuScope = target.locator('[data-worktree-context-menu-scope="worktree"]')
  await expect(contextMenuScope).toBeVisible()
  await contextMenuScope.click({ button: 'right' })
  const deleteItem = orcaPage.getByRole('menuitem', { name: /^Delete(?:\s|$)/ })
  await expect(deleteItem).toBeVisible()
  await expect(deleteItem).toBeInViewport()
  await pauseForVisualProof(orcaPage)
  await startRowRemovalSampling(orcaPage, targetId, belowId)
  await deleteItem.click()

  await expect(target).toHaveCount(0)
  await expect(below).toBeVisible()
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId ?? null))
    .toBe(successorId)
  const frames = await finishRowRemovalSampling(orcaPage)
  await pauseForVisualProof(orcaPage)
  const mountedTops = frames.flatMap((frame) => (frame.belowTop === null ? [] : [frame.belowTop]))
  const firstRemovedFrame = frames.findIndex((frame) => !frame.targetExists)
  const scrollTopBeforeDelete = frames[0]?.scrollTop
  if (scrollTopBeforeDelete === undefined) {
    throw new Error('Row removal sampler recorded no pre-delete frame')
  }

  expect(firstRemovedFrame).toBeGreaterThan(0)
  expect(frames.slice(firstRemovedFrame).every((frame) => !frame.targetExists)).toBe(true)
  expect(Math.max(...frames.map((frame) => frame.animationCount))).toBeGreaterThan(0)
  expect(Math.max(...mountedTops) - Math.min(...mountedTops)).toBeGreaterThan(30)
  expect(Math.max(...frames.map((frame) => frame.scrollTop))).toBeLessThanOrEqual(
    scrollTopBeforeDelete + 1
  )
  expect(Math.min(...frames.map((frame) => frame.scrollTop))).toBeGreaterThanOrEqual(
    scrollTopBeforeDelete - 1
  )
  await expect(
    orcaPage.locator(`[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(successorId)}]`)
  ).toHaveCount(0)
})

test('reduced motion removes the active row without animating its neighbor', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  await waitForSessionReady(orcaPage)
  const { belowId, targetId } = await seedActiveDeletionRows(orcaPage, testInfo)
  await prepareScrolledActiveRow(orcaPage, targetId)

  await startRowRemovalSampling(orcaPage, targetId, belowId)
  await evaluatePolled(
    orcaPage,
    async (targetId) => {
      const removed = await window
        .__store!.getState()
        .removeWorktree({ id: targetId, executionHostId: 'local' })
      if (!removed.ok) {
        throw new Error(removed.error)
      }
    },
    targetId
  )
  const frames = await finishRowRemovalSampling(orcaPage)

  expect(frames.some((frame) => !frame.targetExists)).toBe(true)
  expect(Math.max(...frames.map((frame) => frame.animationCount))).toBe(0)
})
