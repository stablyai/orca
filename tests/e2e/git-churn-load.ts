/**
 * Real git-subprocess churn for the multi-workspace typing bench.
 *
 * Why this exists: every pre-existing scenario in
 * terminal-multi-workspace-typing-latency.spec.ts loads the app with PTY bytes
 * only, and PTY bytes turn out to be cheap — 24 hidden panes at 512 KB/s left
 * typing at 17 ms p50 because main drops hidden renderer-bound bytes at the
 * hidden-delivery gate. What the field reports actually have and the bench did
 * not is dozens of repositories being polled by the sidebar/source-control
 * pollers, which spawn a git child per worktree. Those pollers are gated on
 * document visibility (isWindowVisible), so a headless bench window never
 * starts them and the dominant main-thread load is simply absent.
 *
 * This drives the same work through the same production path — main's
 * `git:status` handler and its GitAdmissionScheduler — from the renderer, so it
 * runs headless without depending on window visibility or on the sidebar being
 * mounted.
 */
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

// Matches the sibling probes (runtime-graph-publication-probe): the handle must
// live on `window` to survive between page.evaluate calls, and `declare global`
// would need an `interface` the lint rules forbid.
type GitChurnWindow = Window & { __orcaGitChurnLoad?: { stop: () => GitChurnStats } }

/**
 * Builds `repoCount` real repositories, each with `filesPerRepo` tracked files
 * and a dirty working tree, so `git status` does measurable work instead of
 * returning instantly on an empty repo.
 */
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
    // Why nested directories: a flat tree of N files understates the readdir
    // and lstat cost that dominates `git status` on a real checkout.
    for (let fileIndex = 0; fileIndex < filesPerRepo; fileIndex++) {
      const directory = path.join(repoPath, `dir-${fileIndex % 64}`)
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, `file-${fileIndex}.txt`), `content ${fileIndex}\n`)
    }
    git('add', '-A')
    git('commit', '--quiet', '-m', 'seed')
    // Why left dirty: a clean tree lets git short-circuit; the reported setups
    // all have modified worktrees.
    for (let fileIndex = 0; fileIndex < Math.min(filesPerRepo, 64); fileIndex++) {
      const directory = path.join(repoPath, `dir-${fileIndex % 64}`)
      writeFileSync(path.join(directory, `file-${fileIndex}.txt`), `modified ${fileIndex}\n`)
    }
    repos.push({ path: repoPath, index })
  }
  return repos
}

/**
 * Registers each repo with Orca. Required: main's `git:status` handler rejects
 * any path that is not a known repository or worktree ("Access denied: unknown
 * repository or worktree path"), so an unregistered churn loop only measures
 * its own rejection path.
 */
export async function registerGitChurnRepos(
  page: Page,
  repoPaths: string[]
): Promise<{ registered: number; failures: string[] }> {
  return page.evaluate(async (paths) => {
    const failures: string[] = []
    let registered = 0
    for (const repoPath of paths) {
      try {
        // Why inspect the result: repos:add REPORTS failure as { error }, it
        // does not throw, so a try/catch alone would count a refusal as success.
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

/**
 * Starts `concurrency` renderer-side loops that keep calling `git.status`
 * across `repoPaths` until stopped. Each call routes through main's IPC
 * handler and admission scheduler exactly as a sidebar poll does.
 */
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
          // Why the yield: a loop whose call rejects synchronously would spin the
          // renderer thread and measure the spin, not git churn.
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
