/**
 * Rendered evidence for the Recover Sessions picker: one hidden-window capture per provider state.
 * Runs through tests/tools/cross-machine-recovery-rendered/run.mjs, which sets the output dir.
 */
import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { createFakeRecoveryProvider } from './helpers/cross-machine-recovery-fake-provider'
import {
  RECOVERY_RENDERED_SCENARIOS,
  RECOVERY_SCREENSHOT_DIR,
  buildScenarioFixture,
  openRecoverSessionsFromJumpPalette,
  type RecoveryRenderedScenario
} from './helpers/cross-machine-recovery-picker-fixtures'
import { HERMETIC_SHELL_ENV } from './helpers/electron-home-isolation'
import { captureHiddenRendererScreenshot } from './helpers/hidden-renderer-screenshot'

const SHOWS: Record<RecoveryRenderedScenario, (dialog: Locator, row: Locator) => Promise<void>> = {
  complete: async (_dialog, row) => {
    await expect(row).not.toHaveAttribute('data-disabled', 'true')
    await expect(row).toContainText('Complete workspace')
  },
  partial: async (_dialog, row) => {
    await expect(row).toHaveAttribute('data-disabled', 'true')
    await expect(row).toContainText('Not ready: missing transcript')
  },
  paused: async (dialog, row) => {
    await expect(row).toContainText('Paused on cellular')
    await expect(dialog.getByText('Studio Mini (unreachable)')).toBeVisible()
  },
  collision: async (dialog, row) => {
    await row.click()
    await expect(dialog.getByRole('checkbox', { name: 'Already open here' })).toBeDisabled()
    await expect(dialog.getByTestId('cross-machine-recovery-session')).toContainText(
      'Already running on this computer'
    )
  },
  divergence: async (dialog, row) => {
    await row.click()
    await dialog.getByRole('checkbox', { name: 'Refactor parser' }).click()
    await dialog.getByRole('button', { name: 'Recover', exact: true }).click()
    await expect(dialog.getByTestId('cross-machine-recovery-divergence')).toContainText(
      'This computer has a newer local copy of session sess-old.'
    )
  }
}

test.use({ orcaAppExtraEnv: HERMETIC_SHELL_ENV })

test.describe('Cross-machine recovery rendered picker states', () => {
  test.skip(
    process.env.ORCA_RECOVERY_RENDERED_DIR === undefined,
    'Evidence-only: run tests/tools/cross-machine-recovery-rendered/run.mjs'
  )

  for (const scenario of RECOVERY_RENDERED_SCENARIOS) {
    test(`renders the ${scenario} state`, async ({ electronApp, orcaPage }, testInfo) => {
      await waitForSessionReady(orcaPage)
      const worktreeId = await waitForActiveWorktree(orcaPage)
      const worktreePath = await orcaPage.evaluate(
        (id) =>
          Object.values(window.__store!.getState().worktreesByRepo)
            .flat()
            .find((worktree) => worktree.id === id)!.path,
        worktreeId
      )
      const provider = createFakeRecoveryProvider(
        path.join(testInfo.outputDir, 'fake-provider'),
        buildScenarioFixture(scenario, { worktreeId, path: worktreePath })
      )
      await orcaPage.evaluate(async (providerPath) => {
        await window.api.settings.set({ crossMachineRecovery: { providerPath } })
      }, provider.programPath)

      await openRecoverSessionsFromJumpPalette(electronApp, orcaPage)
      const dialog = orcaPage.getByRole('dialog', { name: 'Recover work from another computer' })
      const rows = dialog.getByTestId('cross-machine-recovery-item')
      await expect(rows).toHaveCount(1)
      await SHOWS[scenario](dialog, rows.first())

      const file = `picker-${scenario}.png`
      const body = await captureHiddenRendererScreenshot(
        orcaPage,
        path.join(RECOVERY_SCREENSHOT_DIR, file)
      )
      await testInfo.attach(file, { body, contentType: 'image/png' })
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused()
          )
        )
      ).toBe(true)
    })
  }
})
