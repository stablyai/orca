import type { TestInfo } from '@stablyai/playwright-test'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createBranchCommit,
  createStagedCommitMessageChange,
  openSourceControl,
  seedCleanBranchEmptyState,
  seedCommitMessageComposer,
  seedCreatePrComposer
} from './helpers/source-control-ai-generation'
import {
  installDelayedCommitMessageGenerator,
  installDelayedPrGenerator
} from './helpers/source-control-ai-generators'

function readLog(pathname: string): string {
  try {
    return readFileSync(pathname, 'utf8')
  } catch {
    return ''
  }
}

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

test.describe('Source Control AI PR generation worktree switching', () => {
  test.describe.configure({ mode: 'serial' })

  test('keeps pending PR generation attached to its original worktree', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { primaryWorktreeId, prWorktreeId, prWorktreePath, primaryBranch } =
      await seedCreatePrComposer(orcaPage)
    createBranchCommit(prWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `pr-generation-switch-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-pr-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-pr-generator.log')
    await installDelayedPrGenerator(orcaPage, generatorScriptPath, callLogPath, primaryBranch)

    await openSourceControl(orcaPage, prWorktreeId)
    const generate = orcaPage.getByRole('button', {
      name: 'Generate pull request details with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      orcaPage.getByRole('button', { name: 'Stop generating pull request details' })
    ).toBeVisible()
    await expect
      .poll(() => {
        return readLog(callLogPath)
      })
      .toContain('start')
    const pendingEvidence = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        rightSidebarTab: state?.rightSidebarTab
      }
    })
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '01-pr-generation-pending-on-a.png')
    })

    await openSourceControl(orcaPage, primaryWorktreeId)
    await expect(orcaPage.getByText('Generated PR title after switch')).toHaveCount(0)
    const switchedEvidence = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        visibleGeneratedTitle: document.body.textContent?.includes(
          'Generated PR title after switch'
        )
      }
    })
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '02-switched-to-b-no-generated-fields.png')
    })

    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')
    await openSourceControl(orcaPage, prWorktreeId)
    await expect(orcaPage.getByRole('textbox', { name: 'Pull request title' })).toHaveValue(
      'Generated PR title after switch',
      { timeout: 10_000 }
    )
    await expect(orcaPage.getByRole('textbox', { name: 'Pull request description' })).toHaveValue(
      'Generated PR body after switch'
    )
    const finalEvidence = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        title: (document.querySelector('[aria-label="Pull request title"]') as HTMLInputElement)
          ?.value,
        body: (
          document.querySelector('[aria-label="Pull request description"]') as HTMLTextAreaElement
        )?.value
      }
    })
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '03-returned-to-a-generated-fields.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'pr-generation-evidence.json', {
      expectedOriginalWorktreeId: prWorktreeId,
      expectedOtherWorktreeId: primaryWorktreeId,
      generatorLog: readLog(callLogPath),
      pending: pendingEvidence,
      switchedAway: switchedEvidence,
      returned: finalEvidence
    })
  })

  test('hydrates pending PR generation after Source Control remounts', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { prWorktreeId, prWorktreePath, primaryBranch } = await seedCreatePrComposer(orcaPage)
    createBranchCommit(prWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `pr-generation-remount-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-pr-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-pr-generator.log')
    await installDelayedPrGenerator(orcaPage, generatorScriptPath, callLogPath, primaryBranch)

    await openSourceControl(orcaPage, prWorktreeId)
    const generate = orcaPage.getByRole('button', {
      name: 'Generate pull request details with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      orcaPage.getByRole('button', { name: 'Stop generating pull request details' })
    ).toBeVisible()
    await expect.poll(() => readLog(callLogPath)).toContain('start')

    await orcaPage.evaluate(() => {
      window.__store?.getState().setRightSidebarTab('explorer')
    })
    await expect(
      orcaPage.getByRole('button', { name: 'Stop generating pull request details' })
    ).toHaveCount(0)
    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')

    await openSourceControl(orcaPage, prWorktreeId)
    await expect(orcaPage.getByRole('textbox', { name: 'Pull request title' })).toHaveValue(
      'Generated PR title after switch',
      { timeout: 10_000 }
    )
    await expect(orcaPage.getByRole('textbox', { name: 'Pull request description' })).toHaveValue(
      'Generated PR body after switch'
    )
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '01-remounted-source-control-hydrated-pr-fields.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'pr-generation-remount-evidence.json', {
      expectedOriginalWorktreeId: prWorktreeId,
      generatorLog: readLog(callLogPath)
    })
  })

  test('keeps pending commit message generation attached to its original worktree', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { primaryWorktreeId, commitWorktreeId, commitWorktreePath } =
      await seedCommitMessageComposer(orcaPage)
    createStagedCommitMessageChange(commitWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `commit-message-generation-switch-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-commit-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-commit-generator.log')
    await installDelayedCommitMessageGenerator(orcaPage, generatorScriptPath, callLogPath)

    await openSourceControl(orcaPage, commitWorktreeId)
    await expect(orcaPage.getByText('e2e-commit-message-generation.txt')).toBeVisible({
      timeout: 10_000
    })
    const generate = orcaPage.getByRole('button', {
      name: 'Generate commit message with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      orcaPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toBeVisible()
    await expect
      .poll(() => {
        return readLog(callLogPath)
      })
      .toContain('start')
    const pendingEvidence = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        commitMessage: (
          document.querySelector('[aria-label="Commit message"]') as HTMLTextAreaElement
        )?.value
      }
    })
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '01-commit-message-generation-pending-on-a.png')
    })

    await openSourceControl(orcaPage, primaryWorktreeId)
    await expect(orcaPage.getByText('Generated commit message after switch')).toHaveCount(0)
    await expect(
      orcaPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toHaveCount(0)
    const switchedEvidence = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        visibleGeneratedMessage: document.body.textContent?.includes(
          'Generated commit message after switch'
        )
      }
    })
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '02-switched-to-b-no-generated-commit-message.png')
    })

    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')
    await openSourceControl(orcaPage, commitWorktreeId)
    await expect(orcaPage.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
      'Generated commit message after switch\n\nGenerated from staged e2e-commit-message-generation.txt after switching worktrees',
      { timeout: 10_000 }
    )
    const finalEvidence = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        commitMessage: (
          document.querySelector('[aria-label="Commit message"]') as HTMLTextAreaElement
        )?.value
      }
    })
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '03-returned-to-a-generated-commit-message.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'commit-message-generation-evidence.json', {
      expectedOriginalWorktreeId: commitWorktreeId,
      expectedOtherWorktreeId: primaryWorktreeId,
      generatorLog: readLog(callLogPath),
      pending: pendingEvidence,
      switchedAway: switchedEvidence,
      returned: finalEvidence
    })
  })

  test('hydrates pending commit message generation after Source Control remounts', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const { commitWorktreeId, commitWorktreePath } = await seedCommitMessageComposer(orcaPage)
    createStagedCommitMessageChange(commitWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `commit-message-generation-remount-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-commit-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-commit-generator.log')
    await installDelayedCommitMessageGenerator(orcaPage, generatorScriptPath, callLogPath)

    await openSourceControl(orcaPage, commitWorktreeId)
    const generate = orcaPage.getByRole('button', {
      name: 'Generate commit message with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      orcaPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toBeVisible()
    await expect.poll(() => readLog(callLogPath)).toContain('start')

    await orcaPage.evaluate(() => {
      window.__store?.getState().setRightSidebarTab('explorer')
    })
    await expect(
      orcaPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toHaveCount(0)
    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')

    await openSourceControl(orcaPage, commitWorktreeId)
    await expect(orcaPage.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
      [
        'Generated commit message after switch',
        '',
        'Generated from staged e2e-commit-message-generation.txt after switching worktrees'
      ].join('\n'),
      { timeout: 10_000 }
    )
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '01-remounted-source-control-hydrated-message.png')
    })
    await writeEvidence(
      testInfo,
      screenshotDir,
      'commit-message-generation-remount-evidence.json',
      {
        expectedOriginalWorktreeId: commitWorktreeId,
        generatorLog: readLog(callLogPath)
      }
    )
  })

  test('hides the commit AI composer on a clean branch empty state', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const primaryWorktreeId = await seedCleanBranchEmptyState(orcaPage)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `clean-empty-state-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    await openSourceControl(orcaPage, primaryWorktreeId)
    await expect
      .poll(
        async () => {
          // Why: this full-suite spec shares the physical E2E repo with other
          // workers. Keep DOM assertions inside the reseeded poll instead of
          // racing unrelated real git-status refreshes after the poll settles.
          await seedCleanBranchEmptyState(orcaPage, primaryWorktreeId)
          return orcaPage.evaluate(() => {
            const emptyStateVisible =
              document.body.textContent?.includes('No changes on this branch') === true
            const commitMessageInput = document.querySelector('[aria-label="Commit message"]')
            const commitAiButton = document.querySelector(
              '[aria-label="Generate commit message with AI"]'
            )
            return {
              emptyStateVisible,
              hasCommitMessageInput: commitMessageInput !== null,
              hasCommitAiButton: commitAiButton !== null
            }
          })
        },
        {
          timeout: 10_000,
          message: 'Clean branch empty state did not render without the commit AI composer'
        }
      )
      .toEqual({
        emptyStateVisible: true,
        hasCommitMessageInput: false,
        hasCommitAiButton: false
      })
    await seedCleanBranchEmptyState(orcaPage, primaryWorktreeId)
    await orcaPage.screenshot({
      path: path.join(screenshotDir, '01-clean-branch-no-commit-ai-composer.png')
    })
  })
})
