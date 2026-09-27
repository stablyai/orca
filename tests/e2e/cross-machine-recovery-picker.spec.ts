/**
 * Recover Sessions picker driven end to end against a fake recovery provider executable.
 *
 * Why a fake provider on disk: the picker's contract is the provider CLI's argv, env and JSON, so
 * only a real spawned process proves env scrubbing, --json, progress streaming and group cancel.
 */
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeId, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createFakeRecoveryProvider,
  isProcessAlive
} from './helpers/cross-machine-recovery-fake-provider'
import {
  LOCAL_MACHINE,
  RECOVERY_SCREENSHOT_DIR,
  buildFixture,
  openRecoverSessionsFromJumpPalette
} from './helpers/cross-machine-recovery-picker-fixtures'
import { captureHiddenRendererScreenshot } from './helpers/hidden-renderer-screenshot'

const LEAKED_ENV = {
  ORCA_ENVIRONMENT: 'e2e-remote-environment',
  ORCA_PAIRING_CODE: 'e2e-pairing-code',
  ORCA_REMOTE_PAIRING: 'e2e-remote-pairing'
}

async function captureHiddenRenderer(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const body = await captureHiddenRendererScreenshot(
    page,
    path.join(RECOVERY_SCREENSHOT_DIR, `picker-${name}.png`)
  )
  await testInfo.attach(`picker-${name}.png`, { body, contentType: 'image/png' })
}

async function assertWindowsStayHidden(electronApp: ElectronApplication): Promise<void> {
  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  )
  expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
}

test.use({ orcaAppExtraEnv: LEAKED_ENV })

test.describe('Cross-machine recovery picker', () => {
  test('lists provider items, re-runs divergence, cancels, and reveals the local worktree', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const startWorktreeId = await waitForActiveWorktree(orcaPage)
    const target = await orcaPage.evaluate((activeId) => {
      const state = window.__store!.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id !== activeId)
      if (!worktree) {
        throw new Error('seeded repo has no second worktree')
      }
      return { worktreeId: worktree.id, path: worktree.path }
    }, startWorktreeId)

    const provider = createFakeRecoveryProvider(
      path.join(testInfo.outputDir, 'fake-provider'),
      buildFixture(target)
    )
    await orcaPage.evaluate(async (providerPath) => {
      await window.api.settings.set({ crossMachineRecovery: { providerPath } })
    }, provider.programPath)

    // Why: a remote runtime environment is the window's active host, yet recovery must stay local.
    await orcaPage.evaluate(() => {
      const store = window.__store!
      const settings = store.getState().settings
      store.setState({
        settings: settings
          ? { ...settings, activeRuntimeEnvironmentId: 'e2e-remote-runtime' }
          : settings
      })
    })

    const dialog = orcaPage.getByRole('dialog', { name: 'Recover work from another computer' })
    await expect(dialog).toHaveCount(0)
    await captureHiddenRenderer(orcaPage, testInfo, '1-before')

    await openRecoverSessionsFromJumpPalette(electronApp, orcaPage)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('cross-machine-recovery-destination')).toHaveText(
      `Recovers to this computer (${LOCAL_MACHINE})`
    )
    const rows = dialog.getByTestId('cross-machine-recovery-item')
    await expect(rows).toHaveCount(6)
    await expect(dialog.getByText('Studio Mini (unreachable)')).toBeVisible()

    const row = (name: string) => rows.filter({ hasText: name })
    await expect(row('Partial workspace')).toHaveAttribute('data-disabled', 'true')
    await expect(row('Partial workspace')).toContainText('Not ready: missing transcript')
    await expect(row('Partial workspace')).toContainText('Partial transcript')
    await expect(row('Complete workspace')).not.toHaveAttribute('data-disabled', 'true')

    const deferred = row('Deferred code')
    await expect(deferred.getByTestId('cross-machine-recovery-code-age')).toContainText(
      'Code capture deferred · code from 2 hours ago'
    )
    await expect(deferred.getByTestId('cross-machine-recovery-newer-partial')).toContainText(
      'Newer partial checkpoint not recovered · sessions from 10 minutes ago · code from 2 hours ago'
    )
    await expect(row('Paused on cellular')).toContainText('Paused on cellular')
    await expect(
      row('Three sessions').getByTestId('cross-machine-recovery-not-restorable')
    ).toHaveText("Can't recover here: codex codex-7 (agent not supported yet)")
    await captureHiddenRenderer(orcaPage, testInfo, '2-open')

    await row('Collision workspace').click()
    const collisionCheckbox = dialog.getByRole('checkbox', { name: 'Already open here' })
    await expect(collisionCheckbox).toBeDisabled()
    await expect(collisionCheckbox).toHaveAttribute('aria-checked', 'false')
    await expect(dialog.getByTestId('cross-machine-recovery-session')).toContainText(
      'Already running on this computer'
    )

    await row('Complete workspace').click()
    await dialog.getByRole('button', { name: 'Recover', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('Restoring code…')
    await expect.poll(() => provider.readHang()).not.toBeNull()
    const hang = provider.readHang()!
    expect(isProcessAlive(hang.pid)).toBe(true)
    expect(isProcessAlive(hang.grandchildPid)).toBe(true)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Recovery was cancelled.')
    await expect.poll(() => isProcessAlive(hang.pid)).toBe(false)
    await expect.poll(() => isProcessAlive(hang.grandchildPid)).toBe(false)
    await expect(dialog).toBeVisible()

    await row('Three sessions').click()
    const checkbox = (name: string) => dialog.getByRole('checkbox', { name })
    await expect(dialog.getByTestId('cross-machine-recovery-session')).toHaveCount(3)
    await expect(checkbox('Fix login bug')).toHaveAttribute('aria-checked', 'true')
    await expect(checkbox('Refactor parser')).toHaveAttribute('aria-checked', 'false')
    await expect(checkbox('Background eval')).toHaveAttribute('aria-checked', 'false')
    await checkbox('Refactor parser').click()
    await expect(checkbox('Refactor parser')).toHaveAttribute('aria-checked', 'true')

    await dialog.getByRole('button', { name: 'Recover', exact: true }).click()
    const divergence = dialog.getByTestId('cross-machine-recovery-divergence')
    await expect(divergence).toContainText(
      'This computer has a newer local copy of session sess-old.'
    )
    await captureHiddenRenderer(orcaPage, testInfo, '3-divergence')

    await divergence.getByRole('button', { name: 'Keep local' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(target.worktreeId)
    await captureHiddenRenderer(orcaPage, testInfo, '4-after-pickup')

    const invocations = provider.invocations()
    expect(invocations.length).toBeGreaterThanOrEqual(5)
    for (const invocation of invocations) {
      expect(invocation.argv.at(-1)).toBe('--json')
      expect(invocation.env.ORCA_ENVIRONMENT).toBeNull()
      expect(invocation.env.ORCA_PAIRING_CODE).toBeNull()
      expect(invocation.env.ORCA_REMOTE_PAIRING).toBeNull()
      expect(invocation.env.CC_SYNC_ORCA_CLIENT_INSTANCE_ID).toMatch(/\S/)
    }
    const pickups = invocations.filter((invocation) => invocation.argv[0] === 'pickup')
    expect(pickups.map((invocation) => invocation.argv[1])).toEqual([
      'laptop/ws-complete',
      'laptop/ws-three',
      'laptop/ws-three'
    ])
    const [, divergent, rerun] = pickups
    expect(divergent.argv).toEqual([
      'pickup',
      'laptop/ws-three',
      '--resume',
      'sess-new',
      '--resume',
      'sess-old',
      '--progress',
      'ndjson',
      '--json'
    ])
    const choiceAt = rerun.argv.indexOf('--on-divergence')
    expect(rerun.argv[choiceAt + 1]).toBe('keep-local')
    expect(rerun.argv.toSpliced(choiceAt, 2)).toEqual(divergent.argv)
    expect(startWorktreeId).not.toBe(target.worktreeId)
    await assertWindowsStayHidden(electronApp)
  })
})
