import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { getLargeDiffRenderLimit } from '../../src/shared/large-diff-render-limit'
import { MAX_AUTOMATIC_DIFF_CHANGED_LINES } from '../../src/renderer/src/components/editor/combined-diff-on-demand-load'
import {
  buildLargeTypeScriptFile,
  createIsolatedLargeDiffRepo,
  createIsolatedStagedLocaleDiffRepo
} from './large-diff-repro-fixtures'

test.describe('Large diff freeze repro', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ seedTestRepo: false })
  test('defers a large combined diff until the user loads it', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    await waitForSessionReady(orcaPage)
    const fixture = createIsolatedLargeDiffRepo()
    // Why: Windows keeps the watched fixture repo locked until Electron exits.
    registerPostElectronShutdownCleanup(async () => {
      rmSync(fixture.repoPath, { recursive: true, force: true })
    })

    const worktreeId = await addAndActivateRepo(orcaPage, fixture.repoPath)
    writeFileSync(
      fixture.absolutePath,
      buildLargeTypeScriptFile(MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1)
    )
    await orcaPage.evaluate(
      async ({ wId, repoPath, relativePath }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        let status = await window.api.git.status({ worktreePath: repoPath })
        let entry = status.entries.find(
          (candidate) => candidate.path === relativePath && candidate.area === 'unstaged'
        )
        // Why: the app may still be settling the just-added worktree's first status read.
        const statusDeadline = performance.now() + 5_000
        while (!entry && performance.now() < statusDeadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 100))
          status = await window.api.git.status({ worktreePath: repoPath })
          entry = status.entries.find(
            (candidate) => candidate.path === relativePath && candidate.area === 'unstaged'
          )
        }
        if (!entry) {
          throw new Error(`large diff status entry not found: ${relativePath}`)
        }
        store.getState().setGitStatus(wId, status)
        store.getState().openAllDiffs(wId, repoPath, undefined, 'unstaged', [entry])
      },
      { wId: worktreeId, repoPath: fixture.repoPath, relativePath: fixture.relativePath }
    )

    const prompt = orcaPage.getByTestId('large-diff-load-prompt')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Large diffs are not rendered by default.')
    await expect(orcaPage.locator('diffs-container')).toHaveCount(0)

    await prompt.getByRole('button', { name: 'Load diff' }).click()

    await expect(prompt).toHaveCount(0)
    await expect(
      orcaPage.locator('diffs-container [data-content] [data-line]').first()
    ).toBeVisible({ timeout: 30_000 })
  })

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
            editorCount = [...document.querySelectorAll('diffs-container')].filter((host) =>
              host.shadowRoot?.querySelector('[data-content] [data-line]')
            ).length
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
      // Steady-state responsiveness is the contract this test defends, and it is the axis
      // @pierre/diffs improved: p95 lag is ~2ms here versus ~7ms on the Monaco renderer this
      // replaced. Assert it tightly so a real freeze still fails the run.
      expect(measurement.p95LagMs).toBeLessThan(50)
      // The max bound is deliberately looser than Monaco's ~110ms. Pierre's worker returns the
      // themed AST for the WHOLE file in one message (WorkerPoolManager.highlightDiffAST submits
      // no render range), so opening a large diff costs one ~450ms main-thread deserialization
      // where Monaco tokenized lazily per viewport. Measured on one machine, 60k lines:
      // Monaco 92-129ms worst stall / 5.9s to painted diff; Pierre 438-461ms / 3.8s. On a sparse
      // realistic diff Pierre's stall is ~820-904ms. A known regression in stall SHAPE, not a
      // freeze -- do not raise this bound further without re-measuring both renderers.
      expect(measurement.maxLagMs).toBeLessThan(1_500)
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
          const staleUnstagedEntries = entries.map((entry) => ({
            ...entry,
            area: 'unstaged' as const
          }))
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
              editorCount = [...document.querySelectorAll('diffs-container')].filter((host) =>
                host.shadowRoot?.querySelector('[data-content] [data-line]')
              ).length
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

          const classHits = [...document.querySelectorAll('diffs-container')].reduce(
            (total, host) =>
              total +
              (host.shadowRoot?.querySelectorAll('[data-content] [data-line-type^="change-"]')
                .length ?? 0),
            0
          )
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

  test('a wholly replaced file parses without freezing and scrolls through virtual rows', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const contents = (prefix: string) =>
      Array.from({ length: 6_000 }, (_, i) => `${prefix} ${i}\n`).join('')
    const fixture = createIsolatedLargeDiffRepo(contents('old'))
    registerPostElectronShutdownCleanup(async () =>
      rmSync(fixture.repoPath, { recursive: true, force: true })
    )
    writeFileSync(fixture.absolutePath, contents('new'))
    writeFileSync(path.join(fixture.repoPath, 'other.txt'), 'another file\n')
    await waitForSessionReady(orcaPage)
    await addAndActivateRepo(orcaPage, fixture.repoPath)
    await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
    const changedFile = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: fixture.relativePath.split(/[\\/]/).at(-1) })
    await expect(changedFile).toBeVisible()
    const probe = await orcaPage.evaluateHandle(() => {
      const value = { last: performance.now(), maxGap: 0, samples: 0, timer: 0 }
      value.timer = window.setInterval(() => {
        const now = performance.now()
        value.maxGap = Math.max(value.maxGap, now - value.last)
        value.last = now
        value.samples++
      }, 25)
      return value
    })
    try {
      await changedFile.click()
      await expect(
        orcaPage
          .locator('diffs-container [data-content] [data-line]')
          .filter({ hasText: /^new 0$/ })
      ).toBeVisible({ timeout: 30_000 })
      const mountedRows = orcaPage.locator('diffs-container [data-content] [data-line]')
      expect(await mountedRows.count()).toBeLessThan(600)
      await orcaPage.locator('diffs-container').evaluate((host) => {
        const viewport = host.closest('.scrollbar-editor')!
        viewport.scrollTop = viewport.scrollHeight
      })
      await expect(mountedRows.filter({ hasText: /^new 5999$/ })).toBeVisible()
      await orcaPage.screenshot({ path: testInfo.outputPath('last-virtual-row.png') })
      await mountedRows.filter({ hasText: /^new 5999$/ }).click()
      await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
      await orcaPage.keyboard.type('!')
      await orcaPage
        .locator('[data-testid="source-control-entry"]')
        .filter({ hasText: 'other.txt' })
        .click()
      await expect(orcaPage.locator('diffs-container [data-content]')).toContainText('another file')
      const measurement = await probe.evaluate((value) => ({
        maxGap: value.maxGap,
        samples: value.samples
      }))
      expect(measurement.samples).toBeGreaterThan(5)
      expect(measurement.maxGap).toBeLessThan(1_000)
      await changedFile.click()
      await expect(
        orcaPage
          .locator('diffs-container [data-content] [data-line]')
          .filter({ hasText: /^new 5999!$/ })
      ).toBeVisible({ timeout: 30_000 })
      await orcaPage.screenshot({ path: testInfo.outputPath('restored-draft.png') })
      await orcaPage.locator('diffs-container [contenteditable="true"]').focus()
      await orcaPage.keyboard.press('ControlOrMeta+z')
      await expect(mountedRows.filter({ hasText: /^new 5999$/ })).toBeVisible()
    } finally {
      await probe.evaluate((value) => window.clearInterval(value.timer))
      await probe.dispose()
    }
  })
})
