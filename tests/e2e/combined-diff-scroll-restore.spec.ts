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
  lineHeight: number
  lineText: string
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
    const container = document.querySelector<HTMLElement>('[data-combined-diff-viewport]')
    if (!container) {
      throw new Error('combined diff scroll container not found')
    }
    const target = 7_000
    container.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: target })
    )
  })
}

async function readViewportAnchor(page: Page): Promise<ViewportAnchor | null> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('[data-combined-diff-viewport]')
    if (!container) {
      return null
    }
    const containerRect = container.getBoundingClientRect()
    const scene = container.firstElementChild
    const sceneHeight = scene instanceof HTMLElement ? scene.style.height : undefined
    const visibleRows: ViewportAnchor[] = []
    for (const row of container.querySelectorAll<HTMLElement>('[data-combined-diff-section-row]')) {
      const key = row.dataset.combinedDiffSectionKey
      const file = key?.match(/scroll-(\d+)/)
      if (!key || !file) {
        continue
      }
      const index = Number(file[1])
      for (const line of row.querySelectorAll<HTMLElement>('.editor.modified .view-line')) {
        const rect = line.getBoundingClientRect()
        const lineText = line.textContent ?? ''
        const position = lineText.match(/(?:base|changed)_(\d+)_(\d+)/)
        const x = Math.max(rect.left, containerRect.left) + 12
        const y = Math.max(rect.top, containerRect.top) + Math.min(8, rect.height / 2)
        if (
          !position ||
          rect.bottom <= containerRect.top ||
          rect.top >= containerRect.bottom ||
          !line.contains(document.elementFromPoint(x, y))
        ) {
          continue
        }
        const lineIndex = Number(position[2]) + (lineText.includes('changed_') ? 20 : 0)
        visibleRows.push({
          key,
          index,
          lineText,
          top: rect.top - containerRect.top,
          bottom: rect.bottom - containerRect.top,
          lineHeight: rect.height,
          scrollTop: (index * 201 + lineIndex) * rect.height - (rect.top - containerRect.top),
          scrollHeight: Number.parseFloat(sceneHeight ?? '0'),
          clientHeight: container.clientHeight
        })
      }
    }
    visibleRows.sort((a, b) => a.top - b.top)
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
      const signature = `${anchor.key}:${anchor.lineText}:${Math.round(anchor.top)}:${Math.round(
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

// Poll through Monaco’s layout passes until the restored anchor converges; return the last anchor on timeout so misses still fail.
async function waitForRestoredViewportAnchor(
  page: Page,
  target: ViewportAnchor,
  tolerancePx = 80
): Promise<ViewportAnchor> {
  // Start the restoration window after the up-to-15s anchor settle, or slow setup can consume it.
  let lastAnchor = await waitForStableViewportAnchor(page)
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (
      lastAnchor.key === target.key &&
      Math.abs(lastAnchor.scrollTop - target.scrollTop) < tolerancePx
    ) {
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

async function wheelCombinedDiffDown(page: Page): Promise<ScrollProbeSample[]> {
  const container = page.locator('[data-combined-diff-viewport]')
  const box = await container.boundingBox()
  if (!box) {
    throw new Error('combined diff scroll container bounds not found')
  }
  const samples: ScrollProbeSample[] = []
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.wheel(0, 520)
    const sample = await readViewportAnchor(page)
    if (sample) {
      samples.push(sample)
    }
  }
  return samples
}

function getLargestBackwardScrollJump(samples: readonly ScrollProbeSample[]): number {
  let largestBackwardJump = 0
  for (let index = 1; index < samples.length; index += 1) {
    // Count backward jumps only at stable content height; lazy Monaco measurement legitimately corrects scrollTop.
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
  // After tab switch, wait for asynchronously painted Monaco lines rather than treating a transient empty view as failure.
  let linePoint: { x: number; y: number } | null | undefined
  await expect
    .poll(
      async () => {
        linePoint = await page.evaluate(() => {
          const container = document.querySelector<HTMLElement>('[data-combined-diff-viewport]')
          if (!container) {
            return null
          }
          const containerRect = container.getBoundingClientRect()
          for (const line of container.querySelectorAll<HTMLElement>(
            '.monaco-diff-editor .view-line'
          )) {
            const rect = line.getBoundingClientRect()
            const left = Math.max(rect.left, containerRect.left)
            const right = Math.min(rect.right, containerRect.right)
            const top = Math.max(rect.top, containerRect.top)
            const bottom = Math.min(rect.bottom, containerRect.bottom)
            if (left >= right || top >= bottom) {
              continue
            }
            const point = {
              x: left + Math.min(12, (right - left) / 2),
              y: (top + bottom) / 2
            }
            // Sticky headers can cover a line whose rectangle intersects the viewport.
            if (line.contains(document.elementFromPoint(point.x, point.y))) {
              return point
            }
          }
          return null
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

  test('keeps the visible section anchored after switching tabs', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const fixture = createCombinedDiffScrollRepo()

    try {
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      const diffTabId = await openCombinedDiff(orcaPage, worktreeId, fixture.repoPath)
      await expect(orcaPage.locator('[data-combined-diff-viewport]')).toBeVisible()
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
      await expect(orcaPage.locator('[data-combined-diff-viewport]')).toHaveCount(0)

      await orcaPage.locator(`[data-tab-id="${diffTabId}"]`).click({ force: true })
      await expect(orcaPage.locator('[data-combined-diff-viewport]')).toBeVisible()
      const afterSwitch = await waitForRestoredViewportAnchor(orcaPage, beforeSwitch)

      await testInfo.attach('tab-return-anchors', {
        body: JSON.stringify({ beforeSwitch, afterSwitch }, null, 2),
        contentType: 'application/json'
      })
      if (
        afterSwitch.key !== beforeSwitch.key ||
        Math.abs(afterSwitch.scrollTop - beforeSwitch.scrollTop) >= 80
      ) {
        await testInfo.attach('tab-return-before-cleanup', {
          body: await orcaPage.screenshot(),
          contentType: 'image/png'
        })
      }
      expect(afterSwitch.key).toBe(beforeSwitch.key)
      expect(Math.abs(afterSwitch.scrollTop - beforeSwitch.scrollTop)).toBeLessThan(80)

      await clickVisibleDiffLine(orcaPage)
      const afterLineClick = await waitForStableViewportAnchor(orcaPage)

      // Compare a visible source-line witness, including its displacement within the viewport.
      expect(Math.abs(afterLineClick.scrollTop - afterSwitch.scrollTop)).toBeLessThan(80)
      // Compare source-line drift only when the logical content height is unchanged.
      if (afterLineClick.scrollHeight === afterSwitch.scrollHeight) {
        expect(Math.abs(afterLineClick.scrollTop - afterSwitch.scrollTop)).toBeLessThan(40)
      }
    } finally {
      rmSync(fixture.repoPath, { recursive: true, force: true })
    }
  })
  test('keeps a note selection focused while its bounded editor scrolls away', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const fixture = createCombinedDiffScrollRepo()
    try {
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      await openCombinedDiff(orcaPage, worktreeId, fixture.repoPath)
      const viewport = orcaPage.locator('[data-combined-diff-viewport]')
      await expect(viewport).toBeVisible()
      const line = orcaPage
        .locator('.modified-in-monaco-diff-editor .view-line')
        .filter({ hasText: 'export const changed_0_5 = 5' })
        .first()
      await expect(line).toBeVisible()
      await line.hover({ position: { x: 4, y: 8 } })
      await orcaPage.locator('.orca-diff-comment-add-btn:visible').click()

      for (const kind of ['draft', 'saved'] as const) {
        const card = orcaPage.locator(
          kind === 'draft' ? '.orca-diff-comment-draft-card' : '.orca-diff-comment-card'
        )
        if (kind === 'saved') {
          await card.getByTitle('Edit note').click()
        }
        const textarea = card.locator('textarea')
        await expect(textarea).toBeFocused()
        await textarea.fill('alpha beta gamma')
        await textarea.press('Home')
        for (let step = 0; step < 6; step++) {
          await orcaPage.keyboard.press('ArrowRight')
        }
        for (let step = 0; step < 4; step++) {
          await orcaPage.keyboard.press('Shift+ArrowRight')
        }
        const input = await textarea.elementHandle()
        if (!input) {
          throw new Error('note textarea missing')
        }
        const selection = () =>
          input.evaluate((element) => ({
            focused: document.activeElement === element,
            start: element.selectionStart,
            end: element.selectionEnd,
            body: element.value
          }))
        await expect.poll(selection).toEqual({
          focused: true,
          start: 6,
          end: 10,
          body: 'alpha beta gamma'
        })
        const bounds = await viewport.boundingBox()
        if (!bounds) {
          throw new Error('combined viewport bounds missing')
        }
        await viewport.hover({ position: { x: 8, y: 100 } })
        const distance = kind === 'draft' ? 1600 : 6000
        await orcaPage.mouse.wheel(0, distance)
        await expect(textarea).not.toBeInViewport()
        await expect.poll(selection).toEqual({
          focused: true,
          start: 6,
          end: 10,
          body: 'alpha beta gamma'
        })
        await orcaPage.mouse.wheel(0, -distance)
        await expect(textarea).toBeInViewport()
        await expect.poll(selection).toEqual({
          focused: true,
          start: 6,
          end: 10,
          body: 'alpha beta gamma'
        })
        await orcaPage.keyboard.insertText('FOCUS')
        await expect(textarea).toHaveValue('alpha FOCUS gamma')
        await testInfo.attach(`${kind}-focus-after-return`, {
          body: await orcaPage.screenshot(),
          contentType: 'image/png'
        })
        if (kind === 'draft') {
          await card.getByRole('button', { name: /add note/i }).click()
          await expect(orcaPage.locator('.orca-diff-comment-card')).toContainText(
            'alpha FOCUS gamma'
          )
        } else {
          await viewport.hover({ position: { x: 8, y: 100 } })
          await orcaPage.mouse.wheel(0, distance)
          await expect(textarea).not.toBeInViewport()
          await viewport.click({ position: { x: 8, y: 100 } })
          await expect(textarea).not.toBeFocused()
          await orcaPage.mouse.wheel(0, -distance)
          await expect(textarea).toBeInViewport()
          await expect(textarea).not.toBeFocused()
          await card.getByRole('button', { name: /cancel/i }).click()
          await expect(textarea).toHaveCount(0)
        }
      }
    } finally {
      rmSync(fixture.repoPath, { recursive: true, force: true })
    }
  })
})
