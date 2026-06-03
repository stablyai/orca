import { execFileSync } from 'child_process'
import { existsSync, readFileSync, realpathSync } from 'fs'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

// Repro command:
//   SKIP_BUILD=1 pnpm exec playwright test tests/e2e/git-no-upstream-polling-churn.spec.ts --config tests/playwright.config.ts --project electron-headless --reporter=json
// Trigger: active worktree branch "Initi-Project" has no configured upstream
// and no same-name origin ref, then the source-control poller runs for 7.2s.

type DiagnosticsStatus = {
  localFileEnabled: boolean
  bundleEnabled: boolean
  traceFilePath: string
}

type RendererTimerMeasurement = {
  elapsedMs: number
  maxTimerDriftMs: number
  samples: number
}

type GitProbeFailureCounts = {
  noConfiguredUpstreamFailures: number
  missingSameNameOriginFailures: number
}

const ISSUE_BRANCH_NAME = 'Initi-Project'
const POLLING_WINDOW_MS = 7_200
const TIMER_SAMPLE_MS = 16
const MAX_RENDERER_TIMER_DRIFT_MS = 500

function prepareNoUpstreamBranch(repoPath: string): void {
  execFileSync('git', ['checkout', '-B', ISSUE_BRANCH_NAME], { cwd: repoPath, stdio: 'pipe' })
  try {
    execFileSync('git', ['branch', '--unset-upstream', ISSUE_BRANCH_NAME], {
      cwd: repoPath,
      stdio: 'pipe'
    })
  } catch {
    // No upstream is the fixture state we need for the #4559 log pattern.
  }
  try {
    execFileSync('git', ['update-ref', '-d', `refs/remotes/origin/${ISSUE_BRANCH_NAME}`], {
      cwd: repoPath,
      stdio: 'pipe'
    })
  } catch {
    // Missing same-name origin ref is the fixture state we need.
  }
}

async function selectRepoForActivePolling(
  page: Page,
  repoPath: string,
  worktreePath: string
): Promise<void> {
  await page.evaluate(
    async ({ targetRepoPath, targetWorktreePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Expected e2e store to be exposed')
      }

      let state = store.getState()
      const repo = state.repos.find((candidate) => candidate.path === targetRepoPath)
      if (!repo) {
        throw new Error(`Expected repo to be loaded: ${targetRepoPath}`)
      }
      await state.fetchWorktrees(repo.id)

      state = store.getState()
      const worktrees = Object.values(state.worktreesByRepo).flat()
      const worktree = worktrees.find((candidate) => candidate.path === targetWorktreePath)
      if (!worktree) {
        throw new Error(
          `Expected active-polling worktree to exist: ${targetWorktreePath}; saw ${worktrees
            .map((candidate) => candidate.path)
            .join(', ')}`
        )
      }
      state.setActiveWorktree(worktree.id)
      state.setRightSidebarOpen(true)
      state.setRightSidebarTab('source-control')
    },
    { targetRepoPath: repoPath, targetWorktreePath: worktreePath }
  )
}

async function readDiagnosticsStatus(page: Page): Promise<DiagnosticsStatus> {
  return page.evaluate(() => window.api.diagnostics.getStatus() as Promise<DiagnosticsStatus>)
}

async function clearTraceFile(page: Page): Promise<void> {
  await page.evaluate(() => window.api.diagnostics.clearTraces())
}

async function flushTraceFile(page: Page, diagnostics: DiagnosticsStatus): Promise<void> {
  if (diagnostics.bundleEnabled) {
    await page.evaluate(() => window.api.diagnostics.collectBundle(1))
    return
  }
  await page.waitForTimeout(500)
}

async function measureRendererDuringPolling(page: Page): Promise<RendererTimerMeasurement> {
  return page.evaluate(
    async ({ pollWindowMs, sampleMs }) => {
      let maxTimerDriftMs = 0
      let samples = 0
      let lastTick = performance.now()
      const startedAt = lastTick
      const timer = window.setInterval(() => {
        const now = performance.now()
        maxTimerDriftMs = Math.max(maxTimerDriftMs, now - lastTick - sampleMs)
        lastTick = now
        samples += 1
      }, sampleMs)

      await new Promise((resolve) => window.setTimeout(resolve, pollWindowMs))
      window.clearInterval(timer)
      return {
        elapsedMs: performance.now() - startedAt,
        maxTimerDriftMs,
        samples
      }
    },
    { pollWindowMs: POLLING_WINDOW_MS, sampleMs: TIMER_SAMPLE_MS }
  )
}

function readGitProbeFailureCounts(traceFilePath: string, repoPath: string): GitProbeFailureCounts {
  if (!existsSync(traceFilePath)) {
    return { noConfiguredUpstreamFailures: 0, missingSameNameOriginFailures: 0 }
  }

  const counts = { noConfiguredUpstreamFailures: 0, missingSameNameOriginFailures: 0 }
  for (const line of readFileSync(traceFilePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    let record: {
      name?: string
      attributes?: { cwd?: string }
      exit?: { _tag?: string; cause?: unknown }
    }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (
      record.name !== 'git.exec' ||
      record.attributes?.cwd !== repoPath ||
      record.exit?._tag !== 'Failure'
    ) {
      continue
    }

    const cause = String(record.exit.cause ?? '')
    if (cause.includes('git rev-parse --abbrev-ref HEAD@{u}')) {
      counts.noConfiguredUpstreamFailures += 1
    }
    if (cause.includes(`git rev-parse --verify --quiet refs/remotes/origin/${ISSUE_BRANCH_NAME}`)) {
      counts.missingSameNameOriginFailures += 1
    }
  }
  return counts
}

function annotatePolling(
  testInfo: TestInfo,
  measurement: RendererTimerMeasurement,
  counts: GitProbeFailureCounts
): void {
  testInfo.annotations.push({
    type: 'git-no-upstream-polling-repro',
    description: `elapsed=${measurement.elapsedMs.toFixed(1)}ms maxTimerDrift=${measurement.maxTimerDriftMs.toFixed(
      1
    )}ms samples=${measurement.samples} noUpstreamFailures=${
      counts.noConfiguredUpstreamFailures
    } missingOriginFailures=${counts.missingSameNameOriginFailures}`
  })
}

test.describe('Git no-upstream polling churn repro', () => {
  test('active worktree polling does not repeatedly retry stable no-upstream probes', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const repoPath = realpathSync(testRepoPath)
    prepareNoUpstreamBranch(repoPath)
    await selectRepoForActivePolling(orcaPage, testRepoPath, repoPath)

    const diagnostics = await readDiagnosticsStatus(orcaPage)
    test.skip(!diagnostics.localFileEnabled, 'local diagnostic traces are disabled')

    await clearTraceFile(orcaPage)
    const measurement = await measureRendererDuringPolling(orcaPage)
    await flushTraceFile(orcaPage, diagnostics)
    const counts = readGitProbeFailureCounts(diagnostics.traceFilePath, repoPath)
    annotatePolling(testInfo, measurement, counts)

    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_RENDERER_TIMER_DRIFT_MS)
    // Why: the #4559 trace showed these stable negative upstream probes being
    // retried every poll. One miss is enough to learn that this branch has no
    // configured upstream and no same-name origin ref.
    expect(counts.noConfiguredUpstreamFailures).toBeLessThanOrEqual(1)
    expect(counts.missingSameNameOriginFailures).toBeLessThanOrEqual(1)
  })
})
