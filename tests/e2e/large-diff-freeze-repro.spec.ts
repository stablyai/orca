import { rmSync, writeFileSync } from 'fs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { getLargeDiffRenderLimit } from '../../src/shared/large-diff-render-limit'
import {
  buildLargeTypeScriptFile,
  createIsolatedLargeDiffRepo,
  createIsolatedStagedLocaleDiffRepo
} from './large-diff-repro-fixtures'

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

  test('opening stale unstaged combined diffs after staging keeps the renderer responsive', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = createIsolatedStagedLocaleDiffRepo()

    try {
      const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
      const measurement = await orcaPage.evaluate(
        async ({ wId, repoPath, expectedPaths }) => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is not available')
          }

          const status = await window.api.git.status({ worktreePath: repoPath })
          store.getState().setGitStatus(wId, status)
          const entries = status.entries.filter((entry) => entry.area === 'staged')
          const entryPaths = entries.map((entry) => entry.path)
          const missing = expectedPaths.filter((path) => !entryPaths.includes(path))
          if (missing.length > 0) {
            throw new Error(`staged locale fixture missing entries: ${missing.join(', ')}`)
          }

          // Why: reproduce stale snapshot behavior by opening combined diffs
          // as "unstaged" using entries captured from the staged status snapshot.
          const staleUnstagedEntries = entries.map((entry) => ({ ...entry, area: 'unstaged' }))
          const intervalMs = 50
          const samples: number[] = []
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
          store.getState().openAllDiffs(wId, repoPath, undefined, 'unstaged', staleUnstagedEntries)

          let editorCount = 0
          let fallbackCount = 0
          try {
            while (performance.now() - startedAt < 30_000) {
              await new Promise((resolve) => window.setTimeout(resolve, 50))
              editorCount = document.querySelectorAll('.monaco-diff-editor').length
              fallbackCount = document.querySelectorAll(
                '[data-testid="large-diff-fallback"]'
              ).length
              if (editorCount + fallbackCount >= Math.min(entries.length, 5)) {
                await new Promise((resolve) => window.setTimeout(resolve, 1_000))
                break
              }
            }
          } finally {
            window.clearInterval(timer)
          }

          const classHits = Array.from(
            document.querySelectorAll(
              '.monaco-diff-editor .line-insert, .monaco-diff-editor .line-delete, .monaco-diff-editor .char-insert, .monaco-diff-editor .char-delete'
            )
          ).length
          return {
            editorCount,
            fallbackCount,
            classHits,
            maxLagMs,
            sampleCount: samples.length,
            p95LagMs: samples.length
              ? [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)]
              : 0
          }
        },
        { wId: worktreeId, repoPath: fixture.repoPath, expectedPaths: fixture.relativePaths }
      )

      console.log(`stale unstaged combined diff measurement ${JSON.stringify(measurement)}`)
      expect(measurement.editorCount + measurement.fallbackCount).toBeGreaterThanOrEqual(5)
      expect(measurement.classHits).toBeGreaterThan(0)
      expect(measurement.maxLagMs).toBeLessThan(1_000)
    } finally {
      rmSync(fixture.repoPath, { recursive: true, force: true })
    }
  })
})
