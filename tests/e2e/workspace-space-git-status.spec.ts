import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'

test.describe('Workspace Space git status checks', () => {
  test('checks every scanned deletable row, including rows after the first 50', async ({
    orcaPage,
    testRepoPath
  }) => {
    const worktreeParent = mkdtempSync(path.join(os.tmpdir(), 'orca-space-git-status-'))
    const worktreePaths = Array.from({ length: 60 }, (_, index) =>
      path.join(worktreeParent, `worktree-${index}`)
    )

    try {
      for (const worktreePath of worktreePaths) {
        execFileSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
          cwd: testRepoPath,
          stdio: 'pipe'
        })
      }
      const registeredWorktreePaths = worktreePaths.map((worktreePath) =>
        realpathSync(worktreePath)
      )

      await orcaPage.evaluate(
        async ({ testRepoPath, worktreePaths }) => {
          const store = window.__store
          if (!store) {
            throw new Error('Expected e2e store to be exposed')
          }

          const initialState = store.getState()
          const repo = initialState.repos.find((item) => item.path === testRepoPath)
          if (!repo) {
            throw new Error('Expected test repo to be loaded')
          }
          await initialState.fetchWorktrees(repo.id)
          await window.api.git.status({ worktreePath: worktreePaths[0] })

          const state = store.getState()
          const expectedPaths = new Set(worktreePaths)
          const worktrees = (state.worktreesByRepo[repo.id] ?? []).filter((worktree) =>
            expectedPaths.has(worktree.path)
          )
          if (worktrees.length !== worktreePaths.length) {
            throw new Error(
              `Expected ${worktreePaths.length} registered worktrees, got ${
                worktrees.length
              } from ${(state.worktreesByRepo[repo.id] ?? []).length}: ${(
                state.worktreesByRepo[repo.id] ?? []
              )
                .slice(0, 5)
                .map((worktree) => worktree.path)
                .join(', ')}`
            )
          }
          const rows = worktrees.map((worktree, index) => ({
            worktreeId: worktree.id,
            repoId: repo.id,
            repoDisplayName: repo.displayName,
            repoPath: testRepoPath,
            displayName: worktree.displayName,
            path: worktree.path,
            branch: worktree.branch,
            isMainWorktree: false,
            isRemote: false,
            isSparse: worktree.isSparse,
            canDelete: true,
            lastActivityAt: worktree.lastActivityAt,
            status: 'ok' as const,
            error: null,
            scannedAt: Date.now(),
            sizeBytes: 1000 + index,
            reclaimableBytes: 1000 + index,
            skippedEntryCount: 0,
            topLevelItems: [],
            omittedTopLevelItemCount: 0,
            omittedTopLevelSizeBytes: 0
          }))

          store.setState({
            gitStatusByWorktree: {},
            workspaceSpaceAnalysis: {
              scannedAt: Date.now(),
              totalSizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
              reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes, 0),
              worktreeCount: rows.length,
              scannedWorktreeCount: rows.length,
              unavailableWorktreeCount: 0,
              repos: [
                {
                  repoId: repo.id,
                  displayName: repo.displayName,
                  path: repo.path,
                  isRemote: false,
                  worktreeCount: rows.length,
                  scannedWorktreeCount: rows.length,
                  unavailableWorktreeCount: 0,
                  totalSizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
                  reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes, 0),
                  error: null
                }
              ],
              worktrees: rows
            }
          })
          store.getState().openSpacePage()
        },
        { testRepoPath, worktreePaths: registeredWorktreePaths }
      )

      await expect
        .poll(
          () =>
            orcaPage.evaluate(() => {
              const state = window.__store?.getState()
              if (!state?.workspaceSpaceAnalysis) {
                return 60
              }
              return state.workspaceSpaceAnalysis.worktrees.filter(
                (row) => state.gitStatusByWorktree[row.worktreeId] === undefined
              ).length
            }),
          { timeout: 30_000 }
        )
        .toBe(0)

      await expect(orcaPage.getByText('Keep: git not checked')).toHaveCount(0)
    } finally {
      for (const worktreePath of worktreePaths) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
            cwd: testRepoPath,
            stdio: 'pipe'
          })
        } catch {
          // Best effort cleanup; the fixture removes the source repo after the test.
        }
      }
      rmSync(worktreeParent, { recursive: true, force: true })
    }
  })
})
