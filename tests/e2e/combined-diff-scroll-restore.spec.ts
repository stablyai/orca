import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

type CombinedDiffScrollRepo = {
  repoPath: string
}

type ViewportAnchor = {
  key: string
  index: number
  top: number
  bottom: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type ScrollProbeSample = {
  scrollHeight: number
  scrollTop: number
}

const FILE_COUNT = 18
const ADDED_LINES_PER_FILE = 180

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

function buildBaseFile(fileIndex: number): string {
  return `${Array.from(
    { length: 20 },
    (_, lineIndex) => `export const base_${fileIndex}_${lineIndex} = ${lineIndex}`
  ).join('\n')}\n`
}

function buildModifiedFile(fileIndex: number): string {
  const added = Array.from(
    { length: ADDED_LINES_PER_FILE },
    (_, lineIndex) => `export const changed_${fileIndex}_${lineIndex} = ${fileIndex + lineIndex}`
  ).join('\n')
  return `${buildBaseFile(fileIndex)}${added}\n`
}

function createCombinedDiffScrollRepo(): CombinedDiffScrollRepo {
  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-combined-diff-scroll-')))
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])

  const srcDir = path.join(repoPath, 'src')
  mkdirSync(srcDir, { recursive: true })
  for (let index = 0; index < FILE_COUNT; index += 1) {
    writeFileSync(
      path.join(srcDir, `scroll-${String(index).padStart(2, '0')}.ts`),
      buildBaseFile(index)
    )
  }
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial combined diff scroll fixture'])

  for (let index = 0; index < FILE_COUNT; index += 1) {
    writeFileSync(
      path.join(srcDir, `scroll-${String(index).padStart(2, '0')}.ts`),
      buildModifiedFile(index)
    )
  }

  return { repoPath }
}

async function addAndActivateRepo(page: Page, repoPath: string): Promise<string> {
  const repoId = await page.evaluate(async (pathToRepo: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const addedRepo = await store.getState().addRepoPath(pathToRepo)
    if (!addedRepo) {
      throw new Error(`isolated combined-diff repo not found: ${pathToRepo}`)
    }
    return addedRepo.id
  }, repoPath)

  await expect
    .poll(
      () =>
        page.evaluate(async (targetRepoId: string) => {
          const store = window.__store
          if (!store) {
            return 0
          }
          await store.getState().fetchWorktrees(targetRepoId)
          return store.getState().worktreesByRepo[targetRepoId]?.length ?? 0
        }, repoId),
      {
        timeout: 30_000,
        message: 'isolated combined-diff worktree did not load'
      }
    )
    .toBeGreaterThan(0)

  return page.evaluate(
    ({ targetRepoId, pathToRepo }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const state = store.getState()
      const worktrees = state.worktreesByRepo[targetRepoId] ?? []
      const worktree = worktrees.find((entry) => entry.path === pathToRepo) ?? worktrees[0]
      if (!worktree) {
        throw new Error(`isolated combined-diff worktree not found: ${pathToRepo}`)
      }
      state.setActiveRepo(targetRepoId)
      state.setActiveWorktree(worktree.id)
      return worktree.id
    },
    { targetRepoId: repoId, pathToRepo: repoPath }
  )
}

async function openCombinedDiff(page: Page, worktreeId: string, repoPath: string): Promise<string> {
  return page.evaluate(
    async ({ wId, pathToRepo }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const status = await window.api.git.status({ worktreePath: pathToRepo })
      const entries = status.entries.filter((entry) => entry.area === 'unstaged')
      if (entries.length < 2) {
        throw new Error(`expected multiple unstaged entries, received ${entries.length}`)
      }
      state.setGitStatus(wId, status)
      state.openAllDiffs(wId, pathToRepo, undefined, 'unstaged', entries)

      const nextState = store.getState()
      const activeGroupId = nextState.activeGroupIdByWorktree[wId]
      const activeFileId = nextState.activeFileId
      const tab = (nextState.unifiedTabsByWorktree[wId] ?? []).find(
        (candidate) => candidate.groupId === activeGroupId && candidate.entityId === activeFileId
      )
      if (!tab) {
        throw new Error('combined diff tab was not created')
      }
      return tab.id
    },
    { wId: worktreeId, pathToRepo: repoPath }
  )
}

async function scrollCombinedDiffDeep(page: Page): Promise<void> {
  await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.combined-diff-scroll-container')
    if (!container) {
      throw new Error('combined diff scroll container not found')
    }
    const target = Math.min(7_000, Math.max(0, container.scrollHeight - container.clientHeight - 1))
    container.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: target })
    )
    container.scrollTop = target
    container.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

async function readViewportAnchor(page: Page): Promise<ViewportAnchor | null> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.combined-diff-scroll-container')
    if (!container) {
      return null
    }
    const containerRect = container.getBoundingClientRect()
    const visibleRows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-combined-diff-section-row]')
    )
      .map((row) => {
        const rect = row.getBoundingClientRect()
        const key = row.dataset.combinedDiffSectionKey
        const index = Number(row.dataset.index)
        if (
          !key ||
          !Number.isFinite(index) ||
          rect.height <= 0 ||
          rect.bottom <= containerRect.top ||
          rect.top >= containerRect.bottom
        ) {
          return null
        }
        return {
          key,
          index,
          top: rect.top - containerRect.top,
          bottom: rect.bottom - containerRect.top,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight
        }
      })
      .filter((row): row is ViewportAnchor => row !== null)
      .sort((a, b) => a.top - b.top)
    return visibleRows[0] ?? null
  })
}

async function waitForStableViewportAnchor(page: Page): Promise<ViewportAnchor> {
  const startedAt = Date.now()
  let lastSignature = ''
  let stableSamples = 0
  let lastAnchor: ViewportAnchor | null = null

  while (Date.now() - startedAt < 15_000) {
    const anchor = await readViewportAnchor(page)
    if (anchor) {
      const signature = `${anchor.key}:${Math.round(anchor.top)}:${Math.round(
        anchor.bottom
      )}:${Math.round(anchor.scrollHeight)}`
      if (signature === lastSignature) {
        stableSamples += 1
        if (stableSamples >= 2) {
          return anchor
        }
      } else {
        lastSignature = signature
        stableSamples = 0
      }
      lastAnchor = anchor
    }
    await page.waitForTimeout(100)
  }

  throw new Error(`combined diff viewport anchor did not settle: ${JSON.stringify(lastAnchor)}`)
}

// Why: remounting the diff on tab switch restores scroll in several Monaco
// layout passes, so the first settled anchor can be a mid-restore frame. Poll
// until the anchor converges near the pre-switch offset before asserting; a
// genuine restore miss still surfaces because the last anchor is returned on
// timeout for the caller's assertion to fail on.
async function waitForRestoredViewportAnchor(
  page: Page,
  target: ViewportAnchor,
  tolerancePx = 80
): Promise<ViewportAnchor> {
  // Why: waitForStableViewportAnchor can take up to 15s; start the restoration
  // poll after it settles so a slow first settle does not skip the 10s window.
  let lastAnchor = await waitForStableViewportAnchor(page)
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (lastAnchor.key === target.key && Math.abs(lastAnchor.top - target.top) < tolerancePx) {
      return lastAnchor
    }
    await page.waitForTimeout(100)
    const anchor = await readViewportAnchor(page)
    if (anchor) {
      lastAnchor = anchor
    }
  }
  return lastAnchor
}

async function startCombinedDiffScrollProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type CombinedDiffScrollProbe = {
      samples: ScrollProbeSample[]
      stop: () => void
    }
    const targetWindow = window as typeof window & {
      __combinedDiffScrollProbe?: CombinedDiffScrollProbe
    }
    targetWindow.__combinedDiffScrollProbe?.stop()

    const container = document.querySelector<HTMLElement>('.combined-diff-scroll-container')
    if (!container) {
      throw new Error('combined diff scroll container not found')
    }

    const samples: ScrollProbeSample[] = []
    const record = (): void => {
      samples.push({
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop
      })
    }
    container.addEventListener('scroll', record, { passive: true })
    record()
    targetWindow.__combinedDiffScrollProbe = {
      samples,
      stop: () => container.removeEventListener('scroll', record)
    }
  })
}

async function stopCombinedDiffScrollProbe(page: Page): Promise<ScrollProbeSample[]> {
  return page.evaluate(() => {
    type CombinedDiffScrollProbe = {
      samples: ScrollProbeSample[]
      stop: () => void
    }
    const targetWindow = window as typeof window & {
      __combinedDiffScrollProbe?: CombinedDiffScrollProbe
    }
    const probe = targetWindow.__combinedDiffScrollProbe
    if (!probe) {
      return []
    }
    probe.stop()
    delete targetWindow.__combinedDiffScrollProbe
    return probe.samples
  })
}

async function wheelCombinedDiffDown(page: Page): Promise<ScrollProbeSample[]> {
  const container = page.locator('.combined-diff-scroll-container')
  const box = await container.boundingBox()
  if (!box) {
    throw new Error('combined diff scroll container bounds not found')
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await startCombinedDiffScrollProbe(page)
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.wheel(0, 520)
    await page.waitForTimeout(35)
  }
  await page.waitForTimeout(400)
  return stopCombinedDiffScrollProbe(page)
}

function getLargestBackwardScrollJump(samples: readonly ScrollProbeSample[]): number {
  let largestBackwardJump = 0
  for (let index = 1; index < samples.length; index += 1) {
    // Why: a backward scrollTop delta that coincides with a scrollHeight change
    // is the virtualizer correcting for lazily-measured diff editors above the
    // viewport (expected under CI-timed Monaco measurement), not a scroll-restore
    // anchoring regression. A real regression moves scrollTop at a stable content
    // height, so only those backward jumps count.
    if (samples[index].scrollHeight !== samples[index - 1].scrollHeight) {
      continue
    }
    largestBackwardJump = Math.max(
      largestBackwardJump,
      samples[index - 1].scrollTop - samples[index].scrollTop
    )
  }
  return largestBackwardJump
}

async function clickVisibleDiffLine(page: Page): Promise<void> {
  // Why: after a tab switch Monaco re-lays-out its virtualized diff lines
  // asynchronously, so the visible .view-line set is briefly empty on a loaded
  // CI runner. Poll until a line is painted in the viewport instead of reading
  // it once and throwing on the first miss.
  let linePoint: { x: number; y: number } | null = null
  await expect
    .poll(
      async () => {
        linePoint = await page.evaluate(() => {
          const container = document.querySelector<HTMLElement>('.combined-diff-scroll-container')
          if (!container) {
            return null
          }
          const containerRect = container.getBoundingClientRect()
          const visibleLine = Array.from(
            container.querySelectorAll<HTMLElement>('.monaco-diff-editor .view-line')
          ).find((line) => {
            const rect = line.getBoundingClientRect()
            return (
              rect.height > 0 &&
              rect.bottom > containerRect.top &&
              rect.top < containerRect.bottom &&
              rect.right > containerRect.left &&
              rect.left < containerRect.right
            )
          })
          if (!visibleLine) {
            return null
          }
          const rect = visibleLine.getBoundingClientRect()
          return {
            x: rect.left + Math.min(12, Math.max(1, rect.width / 2)),
            y: rect.top + rect.height / 2
          }
        })
        return linePoint !== null
      },
      { timeout: 10_000, message: 'visible combined diff line not found' }
    )
    .toBe(true)

  if (!linePoint) {
    throw new Error('visible combined diff line not found')
  }
  await page.mouse.click(linePoint.x, linePoint.y)
}

test.describe('Combined diff scroll restore', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ seedTestRepo: false })

  test('keeps the visible section anchored after switching tabs', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const fixture = createCombinedDiffScrollRepo()

    try {
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      const diffTabId = await openCombinedDiff(orcaPage, worktreeId, fixture.repoPath)
      await expect(orcaPage.locator('.combined-diff-scroll-container')).toBeVisible()
      await expect(orcaPage.getByText(`${FILE_COUNT} changed files`)).toBeVisible()

      await scrollCombinedDiffDeep(orcaPage)
      await waitForStableViewportAnchor(orcaPage)
      const activeScrollSamples = await wheelCombinedDiffDown(orcaPage)
      expect(activeScrollSamples.length).toBeGreaterThan(2)
      expect(
        getLargestBackwardScrollJump(activeScrollSamples),
        `backward scroll jump at a stable content height; samples=${JSON.stringify(
          activeScrollSamples
        )}`
      ).toBeLessThan(120)

      const beforeSwitch = await waitForStableViewportAnchor(orcaPage)
      expect(beforeSwitch.index).toBeGreaterThan(0)

      await orcaPage.evaluate((wId) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        store.getState().createTab(wId)
      }, worktreeId)
      await expect(orcaPage.locator('.combined-diff-scroll-container')).toHaveCount(0)

      await orcaPage.locator(`[data-tab-id="${diffTabId}"]`).click({ force: true })
      await expect(orcaPage.locator('.combined-diff-scroll-container')).toBeVisible()
      const afterSwitch = await waitForRestoredViewportAnchor(orcaPage, beforeSwitch)

      expect(afterSwitch.key).toBe(beforeSwitch.key)
      expect(Math.abs(afterSwitch.top - beforeSwitch.top)).toBeLessThan(80)

      await clickVisibleDiffLine(orcaPage)
      const afterLineClick = await waitForStableViewportAnchor(orcaPage)

      // Assert the viewport barely moved rather than an exact anchor key: sections
      // are ~viewport-sized, so a sub-pixel focus scroll from the click can flip the
      // topmost-visible key by one without meaningfully moving the scroll position.
      expect(Math.abs(afterLineClick.scrollTop - afterSwitch.scrollTop)).toBeLessThan(40)
      expect(Math.abs(afterLineClick.top - afterSwitch.top)).toBeLessThan(80)
    } finally {
      rmSync(fixture.repoPath, { recursive: true, force: true })
    }
  })
})
