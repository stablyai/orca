import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const FILE_COUNT = 16

type SectionColourSample = {
  key: string
  linesAt: number
  tokensAt: number | null
}

declare global {
  var __colourProbe:
    | { samples: Map<string, SectionColourSample>; observer: MutationObserver }
    | undefined
}

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

function createRepo(): string {
  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-diff-colour-')))
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])
  mkdirSync(path.join(repoPath, 'src'), { recursive: true })
  const file = (index: number): string => path.join(repoPath, 'src', `colour-${index}.ts`)
  for (let index = 0; index < FILE_COUNT; index += 1) {
    writeFileSync(file(index), `export const base${index} = ${index}\n`)
  }
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'base'])
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const added = Array.from(
      { length: 40 },
      (_, line) => `export function changed${index}_${line}(): string { return 'v${line}' }`
    ).join('\n')
    writeFileSync(file(index), `export const base${index} = ${index}\n${added}\n`)
  }
  return repoPath
}

async function openCombinedDiff(page: Page, repoPath: string): Promise<void> {
  const repoId = await page.evaluate(async (p) => {
    const repo = await window.__store!.getState().addRepoPath(p)
    if (!repo) {
      throw new Error('repo not added')
    }
    return repo.id
  }, repoPath)
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const store = window.__store!
        await store.getState().fetchWorktrees(id)
        return store.getState().worktreesByRepo[id]?.length ?? 0
      }, repoId)
    )
    .toBeGreaterThan(0)
  await page.evaluate(
    async ({ id, p }) => {
      const store = window.__store!
      const state = store.getState()
      const worktree = state.worktreesByRepo[id]!.find((w) => w.path === p)!
      state.setActiveRepo(id)
      state.setActiveWorktree(worktree.id)
      const status = await window.api.git.status({ worktreePath: p })
      const entries = status.entries.filter((entry) => entry.area === 'unstaged')
      state.setGitStatus(worktree.id, status)
      state.openAllDiffs(worktree.id, p, undefined, 'unstaged', entries)
    },
    { id: repoId, p: repoPath }
  )
}

// Record per section when its modified pane is laid out and when it first shows a coloured token.
async function startColourProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const samples = new Map<string, SectionColourSample>()
    const scan = (): void => {
      const now = performance.now()
      for (const row of document.querySelectorAll<HTMLElement>(
        '[data-combined-diff-section-row]'
      )) {
        const key = row.dataset.combinedDiffSectionKey ?? ''
        const pane = row.querySelector('.editor.modified .view-lines')
        // Wait for layout: a pane renders one placeholder line before Monaco measures it.
        if (!pane || pane.querySelectorAll('.view-line').length < 10) {
          continue
        }
        const coloured = [...pane.querySelectorAll('.view-line span span')].some((token) =>
          [...token.classList].some((name) => /^mtk([2-9]|\d\d)/.test(name))
        )
        const sample = samples.get(key) ?? { key, linesAt: now, tokensAt: null }
        if (coloured && sample.tokensAt === null) {
          sample.tokensAt = now
        }
        samples.set(key, sample)
      }
    }
    const observer = new MutationObserver(scan)
    observer.observe(document.body, { childList: true, subtree: true })
    globalThis.__colourProbe = { samples, observer }
  })
}

async function countProbedSections(page: Page): Promise<number> {
  return page.evaluate(() => globalThis.__colourProbe?.samples.size ?? 0)
}

async function stopColourProbe(page: Page): Promise<SectionColourSample[]> {
  return page.evaluate(() => {
    const probe = globalThis.__colourProbe
    probe?.observer.disconnect()
    return [...(probe?.samples.values() ?? [])]
  })
}

test.describe('Combined diff syntax colour', () => {
  test.use({ seedTestRepo: false })

  test('sections scrolled into view are coloured in the first frame they are laid out', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const repoPath = createRepo()
    try {
      await openCombinedDiff(orcaPage, repoPath)
      const container = orcaPage.locator('.combined-diff-scroll-container')
      // Start once the first section is coloured; Monaco loads a language's tokenizer on first use.
      await expect(
        container.locator('.view-line span[class*="mtk"]:not(.mtk1)').first()
      ).toBeVisible()
      await startColourProbe(orcaPage)
      const box = (await container.boundingBox())!
      await orcaPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      // Wheel one step per poll so each section scrolls into view rather than being skipped.
      await expect
        .poll(
          async () => {
            await orcaPage.mouse.wheel(0, 400)
            return countProbedSections(orcaPage)
          },
          { intervals: [40], timeout: 15_000 }
        )
        .toBeGreaterThanOrEqual(FILE_COUNT - 4)
      const samples = await stopColourProbe(orcaPage)
      const gaps = samples.map((s) => ({
        key: s.key,
        gapMs: s.tokensAt === null ? null : Math.round(s.tokensAt - s.linesAt)
      }))
      expect(gaps.filter((gap) => gap.gapMs !== 0)).toEqual([])
    } finally {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})
