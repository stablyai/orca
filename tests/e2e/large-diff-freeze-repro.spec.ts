import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { getLargeDiffRenderLimit } from '../../src/shared/large-diff-render-limit'

type IsolatedLargeDiffRepo = {
  repoPath: string
  relativePath: string
  absolutePath: string
}

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

function createIsolatedLargeDiffRepo(): IsolatedLargeDiffRepo {
  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-large-diff-repro-')))
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])

  mkdirSync(path.join(repoPath, 'src'), { recursive: true })
  const relativePath = path.join('src', `large-diff-${randomUUID()}.ts`)
  const absolutePath = path.join(repoPath, relativePath)
  writeFileSync(absolutePath, 'export const seed = 1\n')
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial large diff repro fixture'])

  return { repoPath, relativePath, absolutePath }
}

async function addAndActivateRepo(orcaPage: Page, repoPath: string): Promise<string> {
  const repoId = await orcaPage.evaluate(async (pathToRepo: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const addedRepo = await store.getState().addRepoPath(pathToRepo)
    if (!addedRepo) {
      throw new Error(`isolated repo not found: ${pathToRepo}`)
    }

    return addedRepo.id
  }, repoPath)

  // Why: fetchWorktrees() resolves before Zustand always reflects the async
  // worktree scan, so poll the same public store path real repo setup uses.
  await expect
    .poll(
      () =>
        orcaPage.evaluate(async (targetRepoId: string) => {
          const store = window.__store
          if (!store) {
            return 0
          }
          await store.getState().fetchWorktrees(targetRepoId)
          return store.getState().worktreesByRepo[targetRepoId]?.length ?? 0
        }, repoId),
      {
        timeout: 30_000,
        message: 'isolated large-diff worktree did not load'
      }
    )
    .toBeGreaterThan(0)

  const worktreeId = await orcaPage.evaluate(
    ({ targetRepoId, pathToRepo }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const state = store.getState()
      const worktrees = state.worktreesByRepo[targetRepoId] ?? []
      const worktree = worktrees.find((entry) => entry.path === pathToRepo) ?? worktrees[0]
      if (!worktree) {
        throw new Error(`isolated worktree not found: ${pathToRepo}`)
      }
      state.setActiveRepo(targetRepoId)
      state.setActiveWorktree(worktree.id)
      return worktree.id
    },
    { targetRepoId: repoId, pathToRepo: repoPath }
  )

  return worktreeId
}

function buildLargeTypeScriptFile(lineCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(`export const largeDiffValue${i} = ${i}`)
  }
  return `${lines.join('\n')}\n`
}

test.describe('Large diff freeze repro', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ seedTestRepo: false })
  test('opening a large single-file diff keeps the renderer responsive', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const fixture = createIsolatedLargeDiffRepo()
    const lineCount = Number(process.env.ORCA_LARGE_DIFF_REPRO_LINES ?? '60000')
    if (!Number.isFinite(lineCount) || lineCount < 0) {
      throw new Error(
        `Invalid ORCA_LARGE_DIFF_REPRO_LINES: ${process.env.ORCA_LARGE_DIFF_REPRO_LINES}`
      )
    }
    const modifiedContent = buildLargeTypeScriptFile(lineCount)
    const expectFallback = getLargeDiffRenderLimit({
      originalContent: 'export const seed = 1\n',
      modifiedContent
    }).limited

    try {
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      writeFileSync(fixture.absolutePath, modifiedContent)
      const measurement = await orcaPage.evaluate(
        async ({ wId, absolutePath, relativePath, expectFallback }) => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is not available')
          }
          const state = store.getState()
          const samples: number[] = []
          const intervalMs = 50
          let last = performance.now()
          let maxLagMs = 0
          const timer = window.setInterval(() => {
            const now = performance.now()
            const lag = Math.max(0, now - last - intervalMs)
            maxLagMs = Math.max(maxLagMs, lag)
            samples.push(lag)
            last = now
          }, intervalMs)

          const startedAt = performance.now()
          state.openDiff(wId, absolutePath, relativePath, 'typescript', false)

          let rendered = false
          let fallbackVisible = false
          let editorCount = 0
          while (performance.now() - startedAt < 30_000) {
            await new Promise((resolve) => window.setTimeout(resolve, 50))
            editorCount = document.querySelectorAll('.monaco-diff-editor').length
            fallbackVisible = Boolean(document.querySelector('[data-testid="large-diff-fallback"]'))
            if ((!expectFallback && editorCount > 0) || (expectFallback && fallbackVisible)) {
              await new Promise((resolve) => window.setTimeout(resolve, 1_000))
              rendered = true
              break
            }
          }

          window.clearInterval(timer)
          const elapsedMs = performance.now() - startedAt
          return {
            rendered,
            elapsedMs,
            maxLagMs,
            editorCount,
            fallbackVisible,
            sampleCount: samples.length,
            p95LagMs: samples.length
              ? [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)]
              : 0
          }
        },
        {
          wId: worktreeId,
          absolutePath: fixture.absolutePath,
          relativePath: fixture.relativePath,
          expectFallback
        }
      )

      console.log(`large diff measurement ${JSON.stringify(measurement)}`)
      expect(measurement.rendered).toBe(true)
      expect(measurement.fallbackVisible).toBe(expectFallback)
      if (expectFallback) {
        expect(measurement.editorCount).toBe(0)
      } else {
        expect(measurement.editorCount).toBeGreaterThan(0)
      }
      expect(measurement.maxLagMs).toBeLessThan(1_000)
    } finally {
      rmSync(fixture.repoPath, { recursive: true, force: true })
    }
  })
})
