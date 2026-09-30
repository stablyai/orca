/**
 * Diagnostic-only measurement: how much of main's event loop does git
 * subprocess orchestration actually consume, and which phase dominates?
 *
 * Why a separate spec from terminal-multi-workspace-typing-latency: that bench
 * measures typing latency UNDER churn, so its numbers mix PTY relay, renderer
 * paint and git. This one runs git churn alone against a hidden window and
 * takes a V8 CPU profile OF THE MAIN PROCESS for each phase, which is the only
 * way to split spawn initiation from stdout drain from porcelain parsing — the
 * churn probe reports spawn initiation only.
 *
 * Run: ORCA_GIT_COST_BENCH=1 ORCA_BACKGROUND_LAUNCH=1 \
 *   npx playwright test tests/e2e/main-thread-git-cost.spec.ts \
 *   --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { expect, test } from './helpers/orca-app'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createGitChurnRepos,
  registerGitChurnRepos,
  startGitChurnLoad,
  stopGitChurnLoad,
  type GitChurnStats
} from './git-churn-load'

type MainThreadReport = {
  t: number
  maxGapMs?: number
  gapsOver50Ms?: number
  gapsOver250Ms?: number
  spawnCount?: number
  spawns?: Record<string, { count: number; blockMsTotal: number; blockMsMax: number }>
  marker?: string
  wallMs: number
}

type Phase = { label: string; repos: number; concurrency: number; seconds: number }

const FILES_PER_REPO = Number(process.env.ORCA_GIT_COST_FILES ?? 400)
const PHASE_SECONDS = Number(process.env.ORCA_GIT_COST_PHASE_SECONDS ?? 20)
const MAX_REPOS = Number(process.env.ORCA_GIT_COST_REPOS ?? 24)

const PHASES: Phase[] = [
  { label: 'idle', repos: 0, concurrency: 0, seconds: PHASE_SECONDS },
  { label: 'c1', repos: MAX_REPOS, concurrency: 1, seconds: PHASE_SECONDS },
  { label: 'c4', repos: MAX_REPOS, concurrency: 4, seconds: PHASE_SECONDS },
  { label: 'c8', repos: MAX_REPOS, concurrency: 8, seconds: PHASE_SECONDS },
  { label: 'c16', repos: MAX_REPOS, concurrency: 16, seconds: PHASE_SECONDS },
  { label: 'c32', repos: MAX_REPOS, concurrency: 32, seconds: PHASE_SECONDS }
]

test.use({
  orcaAppExtraEnv: { ORCA_MAIN_THREAD_DIAGNOSTICS: '1', ORCA_BACKGROUND_LAUNCH: '1' }
})

test.describe('main-thread git orchestration cost', () => {
  test.skip(
    process.env.ORCA_GIT_COST_BENCH !== '1',
    'Diagnostic bench; set ORCA_GIT_COST_BENCH=1 to run'
  )
  test.setTimeout((PHASES.reduce((sum, phase) => sum + phase.seconds, 0) + 600) * 1000)

  test('measures spawn / drain / parse split under git churn', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    const reports: MainThreadReport[] = []
    const stderr = electronApp.process().stderr
    expect(stderr, 'electron stderr must be piped for the churn probe').toBeTruthy()
    let buffer = ''
    stderr?.setEncoding('utf-8')
    stderr?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trimEnd()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        const match = /^\[main-thread\] (\{.*\})$/.exec(line)
        if (!match) {
          continue
        }
        try {
          reports.push({ ...JSON.parse(match[1]), wallMs: Date.now() })
        } catch {
          // ignore malformed probe line
        }
      }
    })

    const churnRoot = mkdtempSync(path.join(tmpdir(), 'orca-git-cost-'))
    const profileDir = path.join(testInfo.outputDir, 'main-profiles')
    mkdirSync(profileDir, { recursive: true })
    const results: Record<string, unknown>[] = []
    try {
      const repos = createGitChurnRepos(churnRoot, MAX_REPOS, FILES_PER_REPO)
      const registration = await registerGitChurnRepos(
        orcaPage,
        repos.map((repo) => repo.path)
      )
      expect(
        registration,
        `churn repos were not registered: ${registration.failures.join('; ')}`
      ).toMatchObject({ registered: repos.length })

      for (const phase of PHASES) {
        const profilePath = path.join(profileDir, `main-${phase.label}.cpuprofile`)
        await startMainProfiler(electronApp)
        const startedAt = Date.now()
        if (phase.concurrency > 0) {
          await startGitChurnLoad(
            orcaPage,
            repos.slice(0, phase.repos).map((repo) => repo.path),
            { concurrency: phase.concurrency, admissionTier: 'status' }
          )
        }
        await new Promise((resolve) => setTimeout(resolve, phase.seconds * 1000))
        const churn: GitChurnStats | null =
          phase.concurrency > 0 ? await stopGitChurnLoad(orcaPage) : null
        const endedAt = Date.now()
        const wallMs = await stopMainProfiler(electronApp, profilePath)
        // Skip the first window: it straddles the previous phase's tail.
        const phaseReports = reports.filter(
          (report) =>
            !report.marker && report.wallMs >= startedAt + 5_000 && report.wallMs <= endedAt + 1_000
        )
        results.push({
          phase: phase.label,
          repos: phase.repos,
          concurrency: phase.concurrency,
          windowMs: endedAt - startedAt,
          profileWallMs: wallMs,
          reportCount: phaseReports.length,
          maxGapMs: Math.max(0, ...phaseReports.map((report) => report.maxGapMs ?? 0)),
          gapsOver50Ms: sum(phaseReports.map((report) => report.gapsOver50Ms ?? 0)),
          gapsOver250Ms: sum(phaseReports.map((report) => report.gapsOver250Ms ?? 0)),
          spawnCount: sum(phaseReports.map((report) => report.spawnCount ?? 0)),
          spawns: mergeSpawns(phaseReports),
          churn,
          profilePath
        })
        console.log(`[git-cost] ${JSON.stringify(results.at(-1))}`)
      }
    } finally {
      await stopGitChurnLoad(orcaPage).catch(() => null)
      rmSync(churnRoot, { recursive: true, force: true })
    }
    const summaryPath = path.join(profileDir, 'summary.json')
    writeFileSync(summaryPath, JSON.stringify({ filesPerRepo: FILES_PER_REPO, results }, null, 2))
    console.log(`[git-cost] summary=${summaryPath}`)
    expect(readFileSync(summaryPath, 'utf8').length).toBeGreaterThan(0)
  })
})

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function mergeSpawns(
  reports: MainThreadReport[]
): Record<string, { count: number; blockMsTotal: number; blockMsMax: number }> {
  const merged: Record<string, { count: number; blockMsTotal: number; blockMsMax: number }> = {}
  for (const report of reports) {
    for (const [key, stats] of Object.entries(report.spawns ?? {})) {
      const entry = (merged[key] ??= { count: 0, blockMsTotal: 0, blockMsMax: 0 })
      entry.count += stats.count
      entry.blockMsTotal = Math.round((entry.blockMsTotal + stats.blockMsTotal) * 100) / 100
      entry.blockMsMax = Math.max(entry.blockMsMax, stats.blockMsMax)
    }
  }
  return merged
}

/** V8 CPU profile of the MAIN process, taken from inside main via node:inspector. */
async function startMainProfiler(electronApp: {
  evaluate: <R, A>(fn: (electron: unknown, arg: A) => R | Promise<R>, arg: A) => Promise<R>
}): Promise<void> {
  await electronApp.evaluate(async (_electron, intervalUs: number) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: diagnostic-only scratch globals owned by this bench.
    const scope = globalThis as unknown as Record<string, unknown>
    const inspector = process.getBuiltinModule('node:inspector')
    const session = new inspector.Session()
    session.connect()
    type InspectorParams = { interval?: number }
    const post = (method: string, params?: InspectorParams): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        session.post(method, params, (error, result) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:inspector types the callback payload as unknown; every Profiler reply is an object.
          error ? reject(error) : resolve(result as Record<string, unknown>)
        )
      })
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: intervalUs })
    await post('Profiler.start')
    scope.__orcaGitCostProfiler = { session, post, startedAt: Date.now() }
  }, 500)
}

async function stopMainProfiler(
  electronApp: {
    evaluate: <R, A>(fn: (electron: unknown, arg: A) => R | Promise<R>, arg: A) => Promise<R>
  },
  outPath: string
): Promise<number> {
  return electronApp.evaluate(async (_electron, target: string) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same bench-owned global installed above.
    const scope = globalThis as unknown as Record<string, unknown>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shape startMainProfiler stored on this same global, in this same process.
    const handle = scope.__orcaGitCostProfiler as {
      session: { disconnect: () => void }
      post: (method: string, params?: { interval?: number }) => Promise<Record<string, unknown>>
      startedAt: number
    }
    const { profile } = await handle.post('Profiler.stop')
    const wallMs = Date.now() - handle.startedAt
    process
      .getBuiltinModule('node:fs')
      .writeFileSync(target, JSON.stringify(profile), { mode: 0o600 })
    handle.session.disconnect()
    delete scope.__orcaGitCostProfiler
    return wallMs
  }, outPath)
}
