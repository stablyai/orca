import { test, expect } from './helpers/orca-app'
import {
  hasConsistentDigestRevision,
  hasNoUndecidedThirdTechnicalAttempt,
  hasValidCarryForwardState,
  launchNativeMaestroFixture,
  maestroJournalFixture,
  resolveMaestroDetail
} from './helpers/maestro-fixture'

test.describe('Maestro navigator journal fixture', () => {
  test('opens exact journal identities and observes run-progress transitions in the visible Canvas', async () => {
    const native = await launchNativeMaestroFixture()
    try {
      expect(hasConsistentDigestRevision()).toBe(true)
      expect(hasValidCarryForwardState()).toBe(true)
      expect(hasNoUndecidedThirdTechnicalAttempt()).toBe(true)
      await expect(native.page.locator('[data-maestro-canvas]')).toBeVisible()
      const progress = native.page.getByLabel('Run Run maestro-worktree-canvas-r16: active')
      await expect(progress).toBeVisible()
      await expect(progress.getByText('74%', { exact: true })).toBeVisible()
      await native.page
        .getByLabel('Maestro navigator')
        .getByRole('button', { name: 'ORC-10 · carry-forward finding · partial 86%' })
        .click()
      await expect(native.page.locator('[data-orc11-detail]')).toHaveText(
        resolveMaestroDetail('finding', 'finding-orc10-hardening')!
      )
      await native.page
        .getByLabel('Maestro navigator')
        .getByRole('button', { name: 'ORC-11 · blocking finding · acceptance reference' })
        .click()
      await expect(native.page.locator('[data-orc11-detail]')).toHaveText(
        resolveMaestroDetail('attempt', 'attempt-orc-11-002')!
      )
      await native.page
        .getByRole('button', { name: 'ORC-09 · attempt-orc-09-002 · active' })
        .click()
      await expect(native.page.locator('[data-orc11-detail]')).toHaveText(
        resolveMaestroDetail('task', 'ORC-09')!
      )
      await native.page
        .getByRole('button', { name: 'Cleanup · tracked workers · released' })
        .click()
      await expect(native.page.locator('[data-orc11-detail]')).toHaveText(
        resolveMaestroDetail('cleanup', 'cleanup-tracked-workers')!
      )
      await expect(native.page.locator('[data-orc11-serial-session]')).toContainText(
        maestroJournalFixture.serialTerminal.taskIds.join(', ')
      )
      await expect(native.page.locator('[data-orc11-fresh-profile]')).toContainText(
        maestroJournalFixture.incompatibleTerminal.terminalId
      )
      const codexReceipt = maestroJournalFixture.launchReceipts.find(
        (receipt) => receipt.agent === 'codex'
      )!
      const claudeReceipt = maestroJournalFixture.launchReceipts.find(
        (receipt) => receipt.agent === 'claude'
      )!
      await expect(native.page.locator('[data-orc11-launch-codex]')).toHaveText(
        `${codexReceipt.agent} ${codexReceipt.model} ${codexReceipt.effort} ${codexReceipt.args.join(' ')}`
      )
      await expect(native.page.locator('[data-orc11-launch-claude]')).toHaveText(
        `${claudeReceipt.agent} ${claudeReceipt.model} ${claudeReceipt.effort} ${claudeReceipt.args.join(' ')}`
      )
      await expect(native.page.locator('[data-orc11-diagnostics]')).toContainText(
        `technical attempts ${maestroJournalFixture.diagnostics.technicalAttempts}`
      )
      await native.page.getByRole('button', { name: 'Show blocked progress' }).click()
      const blockedProgress = native.page.getByLabel('Run Run maestro-worktree-canvas-r16: blocked')
      await expect(blockedProgress).toBeVisible()
      await expect(blockedProgress.getByText('finding-orc11-browser-cleanup')).toBeVisible()
      await native.page.getByRole('button', { name: 'Show partial progress' }).click()
      const partialProgress = native.page.getByLabel('Run Run maestro-worktree-canvas-r16: partial')
      await expect(partialProgress).toBeVisible()
      await expect(partialProgress.getByText('86%', { exact: true })).toBeVisible()
      await expect(partialProgress.getByText('finding-orc10-hardening')).toBeVisible()
      await expect(partialProgress.getByText('100%', { exact: true })).toHaveCount(0)
      await native.page.getByRole('button', { name: 'Show active progress' }).click()
      await expect(
        native.page.getByLabel('Run Run maestro-worktree-canvas-r16: active')
      ).toBeVisible()
      await expect(native.page.getByText('Digest revision 47')).toBeVisible()
    } finally {
      await native.close()
    }
  })
})
