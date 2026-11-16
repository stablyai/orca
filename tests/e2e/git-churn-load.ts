// Drive real git:status admission work explicitly: visibility-gated pollers never start in a hidden bench window.
// PTY-only load misses this field bottleneck because main drops hidden renderer-bound output.
import type { Page } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type GitChurnRepo = { path: string; index: number }

export type GitChurnStats = {
  requested: number
  settled: number
  failed: number
  durationMsTotal: number
  durationMsMax: number
  repos: number
  concurrency: number
  /** First failure's message — a churn loop that only throws measures nothing. */
  firstError: string | null
}

// Keep the handle on window across page.evaluate calls without a suite-wide interface augmentation.
type GitChurnWindow = Window & { __orcaGitChurnLoad?: { stop: () => GitChurnStats } }

// Use dirty, populated repositories so git status cannot short-circuit on an empty tree.
export function createGitChurnRepos(
  rootDirectory: string,
  repoCount: number,
  filesPerRepo: number
): GitChurnRepo[] {
  const repos: GitChurnRepo[] = []
  for (let index = 0; index < repoCount; index++) {
    const repoPath = path.join(rootDirectory, `churn-repo-${index}`)
    mkdirSync(repoPath, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' })
    }
    git('init', '--quiet')
    git('config', 'user.email', 'bench@example.com')
    git('config', 'user.name', 'Bench')
    // Nested directories model the readdir/lstat cost of real checkouts.
    for (let fileIndex = 0; fileIndex < filesPerRepo; fileIndex++) {
      const directory = path.join(repoPath, `dir-${fileIndex % 64}`)
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, `file-${fileIndex}.txt`), `content ${fileIndex}\n`)
    }
    git('add', '-A')
    git('commit', '--quiet', '-m', 'seed')
    // Keep files dirty so git cannot short-circuit the reported workload.
    for (let fileIndex = 0; fileIndex < Math.min(filesPerRepo, 64); fileIndex++) {
      const directory = path.join(repoPath, `dir-${fileIndex % 64}`)
      writeFileSync(path.join(directory, `file-${fileIndex}.txt`), `modified ${fileIndex}\n`)
    }
    repos.push({ path: repoPath, index })
  }
  return repos
}

// Register every repository or git:status measures only its access-denied path.
export async function registerGitChurnRepos(
  page: Page,
  repoPaths: string[]
): Promise<{ registered: number; failures: string[] }> {
  return page.evaluate(async (paths) => {
    const failures: string[] = []
    let registered = 0
    for (const repoPath of paths) {
      try {
        // repos:add reports { error } without throwing; catch alone would count refusals as success.
        const result = await window.api.repos.add({ path: repoPath, kind: 'git' })
        if (result && typeof result === 'object' && 'error' in result) {
          failures.push(String(result.error).slice(0, 200))
        } else {
          registered += 1
        }
      } catch (error) {
        failures.push((error instanceof Error ? error.message : String(error)).slice(0, 200))
      }
    }
    return { registered, failures: failures.slice(0, 5) }
  }, repoPaths)
}

// Drive renderer IPC through the production status handler and scheduler, matching sidebar polling.
export async function startGitChurnLoad(
  page: Page,
  repoPaths: string[],
  options: { concurrency: number; admissionTier: 'interactive' | 'status' | 'background' }
): Promise<void> {
  await page.evaluate(
    ({ paths, concurrency, admissionTier }) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe owns this property on its own renderer window; nothing else reads or writes it.
      const target = window as GitChurnWindow
      target.__orcaGitChurnLoad?.stop()
      let running = true
      const stats: GitChurnStats = {
        requested: 0,
        settled: 0,
        failed: 0,
        durationMsTotal: 0,
        durationMsMax: 0,
        repos: paths.length,
        concurrency,
        firstError: null
      }
      const runLoop = async (lane: number): Promise<void> => {
        let cursor = lane
        while (running) {
          const worktreePath = paths[cursor % paths.length]
          cursor += concurrency
          stats.requested += 1
          const startedAt = performance.now()
          try {
            await window.api.git.status({ worktreePath, admissionTier })
          } catch (error) {
            stats.failed += 1
            stats.firstError ??= (error instanceof Error ? error.message : String(error)).slice(
              0,
              300
            )
          }
          // Yield after synchronous rejection so the benchmark cannot measure a renderer spin loop.
          await new Promise((resolve) => setTimeout(resolve, 0))
          const durationMs = performance.now() - startedAt
          stats.settled += 1
          stats.durationMsTotal += durationMs
          stats.durationMsMax = Math.max(stats.durationMsMax, durationMs)
        }
      }
      for (let lane = 0; lane < concurrency; lane++) {
        void runLoop(lane)
      }
      target.__orcaGitChurnLoad = {
        stop: () => {
          running = false
          return { ...stats }
        }
      }
    },
    { paths: repoPaths, concurrency: options.concurrency, admissionTier: options.admissionTier }
  )
}

export async function stopGitChurnLoad(page: Page): Promise<GitChurnStats | null> {
  return page.evaluate(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same probe-owned property as startGitChurnLoad installs.
      (window as GitChurnWindow).__orcaGitChurnLoad?.stop() ?? null
  )
}
