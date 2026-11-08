import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/source-control-generation-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createStagedCommitMessageChange,
  openSourceControl,
  seedCreatePrComposer
} from './helpers/source-control-ai-generation'

function removeOriginRemoteIfPresent(cwd: string): void {
  // Why: check presence instead of swallowing errors, so real Git failures still surface.
  const remotes = execFileSync('git', ['remote'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
    .split('\n')
    .map((line) => line.trim())
  if (!remotes.includes('origin')) {
    return
  }
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd, stdio: 'pipe' })
}

test.describe('Source Control Create PR intent worktree switching', () => {
  test.describe.configure({ mode: 'serial' })

  test('carries unavailable dirty intent through push to the final create preflight', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { prWorktreeId, prWorktreePath } = await seedCreatePrComposer(orcaPage)
    const remoteRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-create-pr-remote-'))
    const remotePath = path.join(remoteRoot, 'origin.git')
    execFileSync('git', ['init', '--bare', remotePath])
    // Why: the seeded worktree may already define origin, so make the add idempotent.
    removeOriginRemoteIfPresent(prWorktreePath)
    execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: prWorktreePath })
    registerPostElectronShutdownCleanup(async () => {
      removeOriginRemoteIfPresent(prWorktreePath)
      rmSync(remoteRoot, { recursive: true, force: true })
    })
    createStagedCommitMessageChange(prWorktreePath)

    const finalCreateError = 'Unavailable lookup intent reached final create preflight'
    await orcaPage.evaluate(
      ({ prWorktreeId, finalCreateError }) => {
        const store =
          window.__store ??
          (() => {
            throw new Error('window.__store is not available')
          })()
        const state = store.getState()
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === prWorktreeId)
        if (!worktree) {
          throw new Error('Create PR intent worktree not found')
        }
        const branch = worktree.branch.replace(/^refs\/heads\//, '')
        const pushBranchAction = state.pushBranch
        const testWindow = window as unknown as {
          __unavailableIntentPushFinished: boolean
        }
        testWindow.__unavailableIntentPushFinished = false

        store.setState((current) => ({
          repos: current.repos.map((repo) =>
            repo.id === worktree.repoId
              ? {
                  ...repo,
                  gitRemoteIdentity: {
                    canonicalKey: 'github.com/acme/orca',
                    remoteName: 'origin',
                    remoteUrl: 'https://github.com/acme/orca.git'
                  }
                }
              : repo
          ),
          remoteStatusesByWorktree: {
            ...current.remoteStatusesByWorktree,
            [prWorktreeId]: {
              hasUpstream: true,
              upstreamName: `origin/${branch}`,
              ahead: 1,
              behind: 0
            }
          },
          getHostedReviewCreationEligibility: async () => {
            throw new Error('Hosted review eligibility timed out')
          },
          pushBranch: async (...args: Parameters<typeof pushBranchAction>) => {
            const [worktreeId] = args
            if (worktreeId !== prWorktreeId) {
              throw new Error(`Create PR intent pushed unexpected worktree ${worktreeId}`)
            }
            await pushBranchAction(...args)
            testWindow.__unavailableIntentPushFinished = true
          },
          createHostedReview: async () => ({
            ok: false as const,
            code: 'validation' as const,
            error: finalCreateError
          })
        }))
      },
      { prWorktreeId, finalCreateError }
    )

    await openSourceControl(orcaPage, prWorktreeId)
    await expect(orcaPage.getByText('e2e-commit-message-generation.txt')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage
      .getByRole('textbox', { name: 'Commit message' })
      .fill('Exercise unavailable Create PR intent')
    const createPr = orcaPage.getByRole('button', { name: 'Create PR' }).first()
    await expect(createPr).toBeEnabled()
    await createPr.click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () =>
              (window as unknown as { __unavailableIntentPushFinished: boolean })
                .__unavailableIntentPushFinished
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
    await expect(orcaPage.getByText(finalCreateError)).toBeVisible({ timeout: 10_000 })
  })
})
