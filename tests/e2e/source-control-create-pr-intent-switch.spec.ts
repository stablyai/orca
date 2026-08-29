import type { TestInfo } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createStagedCommitMessageChange,
  openSourceControl,
  seedCreatePrComposer
} from './helpers/source-control-ai-generation'

async function writeEvidence(
  testInfo: TestInfo,
  screenshotDir: string,
  filename: string,
  evidence: unknown
): Promise<void> {
  const evidencePath = path.join(screenshotDir, filename)
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  await testInfo.attach(filename, {
    path: evidencePath,
    contentType: 'application/json'
  })
}

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

  test('keeps Create PR intent running after switching worktrees', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { primaryWorktreeId, prWorktreeId, prWorktreePath, primaryBranch } =
      await seedCreatePrComposer(orcaPage)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `create-pr-intent-switch-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    await orcaPage.evaluate(
      ({ prWorktreeId, primaryBranch }) => {
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
        const repo = state.repos.find((entry) => entry.id === worktree.repoId)
        if (!repo) {
          throw new Error('Create PR intent repo not found')
        }
        const branch = worktree.branch.replace(/^refs\/heads\//, '')

        type CreatePrIntentHostedReviewCall = {
          repoPath: string
          input: {
            base?: string
            head?: string
            worktreePath?: string
          }
        }
        const testWindow = window as unknown as {
          __createPRIntentPayloads: CreatePrIntentHostedReviewCall[]
          __createPRIntentPushStarted: boolean
          __createPRIntentPushFinished: boolean
        }
        testWindow.__createPRIntentPayloads = []
        testWindow.__createPRIntentPushStarted = false
        testWindow.__createPRIntentPushFinished = false
        store.setState((current) => ({
          getHostedReviewCreationEligibility: async () => {
            // Why: eligibility stays blocked until the delayed push completes,
            // so this test exercises navigation during an in-flight intent run.
            if (!testWindow.__createPRIntentPushFinished) {
              return {
                provider: 'github' as const,
                review: null,
                canCreate: false,
                blockedReason: 'needs_push' as const,
                nextAction: 'push' as const,
                defaultBaseRef: primaryBranch,
                head: branch
              }
            }
            return {
              provider: 'github' as const,
              review: null,
              canCreate: true,
              blockedReason: null,
              nextAction: null,
              defaultBaseRef: primaryBranch,
              title: 'Create PR intent after switching worktrees',
              body: 'The intent flow should continue after navigation.',
              head: branch
            }
          },
          fetchHostedReviewForBranch: async () => null,
          fetchPRForBranch: async () => null,
          pushBranch: async (worktreeId) => {
            if (worktreeId !== prWorktreeId) {
              throw new Error(`Create PR intent pushed unexpected worktree ${worktreeId}`)
            }
            testWindow.__createPRIntentPushStarted = true
            await new Promise((resolve) => setTimeout(resolve, 1500))
            testWindow.__createPRIntentPushFinished = true
          },
          createHostedReview: async (repoPath, input) => {
            testWindow.__createPRIntentPayloads.push({ repoPath, input })
            return {
              ok: true as const,
              number: 74,
              url: 'https://github.com/acme/orca/pull/74'
            }
          },
          gitStatusByWorktree: {
            ...current.gitStatusByWorktree,
            [worktree.id]: []
          },
          remoteStatusesByWorktree: {
            ...current.remoteStatusesByWorktree,
            [worktree.id]: {
              hasUpstream: true,
              upstreamName: `origin/${branch}`,
              ahead: 1,
              behind: 0
            }
          }
        }))
      },
      { prWorktreeId, primaryBranch }
    )

    await openSourceControl(orcaPage, prWorktreeId)
    const createPr = orcaPage.getByRole('button', { name: 'Create PR' }).first()
    await expect(createPr).toBeVisible({ timeout: 10_000 })
    await expect(createPr).toBeEnabled()
    await createPr.click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () =>
              (window as unknown as { __createPRIntentPushStarted: boolean })
                .__createPRIntentPushStarted
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
    await openSourceControl(orcaPage, primaryWorktreeId)

    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () =>
              (window as unknown as { __createPRIntentPayloads: unknown[] })
                .__createPRIntentPayloads.length
          ),
        { timeout: 10_000 }
      )
      .toBe(1)

    const completedWhileSwitchedEvidence = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        rightSidebarTab: state?.rightSidebarTab
      }
    })
    expect(completedWhileSwitchedEvidence.activeWorktreeId).toBe(primaryWorktreeId)
    expect(completedWhileSwitchedEvidence.rightSidebarTab).toBe('source-control')

    await openSourceControl(orcaPage, prWorktreeId)
    const payloads = await orcaPage.evaluate(
      () =>
        (
          window as unknown as {
            __createPRIntentPayloads: {
              repoPath: string
              input: { base?: string; head?: string; worktreePath?: string }
            }[]
          }
        ).__createPRIntentPayloads
    )
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      input: {
        base: primaryBranch,
        head: 'e2e-secondary',
        worktreePath: prWorktreePath
      }
    })
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '01-create-pr-intent-completed-after-switch.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'create-pr-intent-switch-evidence.json', {
      expectedOriginalWorktreeId: prWorktreeId,
      expectedOtherWorktreeId: primaryWorktreeId,
      completedWhileSwitched: completedWhileSwitchedEvidence,
      payloads
    })
  })

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
