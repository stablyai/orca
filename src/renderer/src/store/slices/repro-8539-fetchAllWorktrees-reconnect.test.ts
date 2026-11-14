/**
 * Issue #8539 — Renderer freezes ~87s on reconnect with many worktrees.
 *
 * Reporter stack: fetchAllWorktrees inside passive mount / reconnect path.
 * Current tree still calls fetchAllWorktrees on startup and again on remote
 * catalog refresh after reconnect. The work is async IPC + per-repo merges;
 * with many repos/worktrees the commit+effect cascade mounts all tab trees.
 *
 * Code-level proof of the call sites (not a live 37-worktree freeze).
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/store/slices/repro-8539-fetchAllWorktrees-reconnect.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('issue #8539 fetchAllWorktrees on reconnect / mount paths', () => {
  it('App startup invokes fetchAllWorktrees at least twice (local + remote refresh)', () => {
    const app = readFileSync(join(__dirname, '../../App.tsx'), 'utf8')
    const matches = app.match(/fetchAllWorktrees/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
    expect(app).toMatch(/fetch-worktrees/)
    expect(app).toMatch(/remote-worktree-refresh/)
    expect(app).toMatch(/reconnect-terminals|reconnectPersistedTerminals/)
  })

  it('fetchAllWorktrees walks every repo with listDetectedWorktrees (O(repos))', () => {
    const worktrees = readFileSync(join(__dirname, 'worktrees.ts'), 'utf8')
    expect(worktrees).toMatch(/fetchAllWorktrees:\s*async/)
    expect(worktrees).toMatch(/mapReposForWorktreeRefresh/)
    expect(worktrees).toMatch(/listDetectedWorktreesForRepoCoalesced/)
    expect(worktrees).toMatch(/mergeWorktreesForHost/)
  })

  it('does not throttle or chunk mount work for large worktree sets in fetchAllWorktrees', () => {
    const worktrees = readFileSync(join(__dirname, 'worktrees.ts'), 'utf8')
    const start = worktrees.indexOf('fetchAllWorktrees: async')
    const slice = worktrees.slice(start, start + 8000)
    expect(slice).not.toMatch(/requestIdleCallback|chunk|yieldToMain|scheduler\.postTask/)
  })
})
