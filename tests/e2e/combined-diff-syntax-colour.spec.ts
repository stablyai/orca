import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const FILE_COUNT = 8

declare global {
  var __colouredWhenLaidOut: Record<string, boolean> | undefined
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

test.describe('Combined diff syntax colour', () => {
  test.use({ seedTestRepo: false })

  test('a section scrolled into view already has syntax colours when its lines are laid out', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const repoPath = createRepo()
    try {
      await openCombinedDiff(orcaPage, repoPath)
      // Monaco loads a language's tokenizer on first use; start once the first section is coloured.
      await expect
        .poll(() =>
          orcaPage.evaluate(() =>
            [...document.querySelectorAll('.combined-diff-scroll-container .view-line')].some(
              (line) =>
                new Set(
                  [...line.querySelectorAll('span span')]
                    // Bracket-pair colours appear without syntax tokens.
                    .filter((t) => !/^[(){}]$/.test(t.textContent ?? ''))
                    .map((t) => getComputedStyle(t).color)
                ).size > 1
            )
          )
        )
        .toBe(true)

      await orcaPage.evaluate(() => {
        const seen: Record<string, boolean> = {}
        globalThis.__colouredWhenLaidOut = seen
        // Record each section once, at the first DOM mutation where its first added line exists.
        new MutationObserver(() => {
          for (const row of document.querySelectorAll<HTMLElement>(
            '[data-combined-diff-section-row]'
          )) {
            const key = row.dataset.combinedDiffSectionKey ?? ''
            const line = [...row.querySelectorAll('.editor.modified .view-line')].find(
              (candidate) => candidate.textContent?.startsWith('export\u00a0function')
            )
            if (key in seen || !line) {
              continue
            }
            const colours = new Set(
              [...line.querySelectorAll('span span')]
                // Bracket-pair colours appear without syntax tokens.
                .filter((t) => !/^[(){}]$/.test(t.textContent ?? ''))
                .map((t) => getComputedStyle(t).color)
            )
            seen[key] = colours.size > 1
          }
        }).observe(document.body, { childList: true, subtree: true })
      })
      await expect
        .poll(
          () =>
            orcaPage.evaluate(() => {
              const container = document.querySelector<HTMLElement>(
                '.combined-diff-scroll-container'
              )!
              container.scrollTop += 400
              return Object.keys(globalThis.__colouredWhenLaidOut ?? {}).length
            }),
          { intervals: [50], timeout: 15_000 }
        )
        .toBe(FILE_COUNT)
      const coloured = await orcaPage.evaluate(() => globalThis.__colouredWhenLaidOut)
      expect(Object.entries(coloured ?? {}).filter(([, value]) => !value)).toEqual([])
    } finally {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})
