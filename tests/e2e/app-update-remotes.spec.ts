import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { AppUpdateBatch } from '../../src/shared/app-update-batch'

const batch: AppUpdateBatch = {
  version: 1,
  targetVersion: '1.6.0',
  stage: 'remotes',
  error: null,
  remotes: [
    {
      environmentId: 'build',
      pairingRevision: 1,
      name: 'Build server',
      phase: 'updated',
      currentVersion: '1.6.0',
      targetVersion: '1.6.0',
      runtimeId: 'build-new',
      progress: null,
      error: null
    },
    {
      environmentId: 'dev',
      pairingRevision: 1,
      name: 'Dev box',
      phase: 'downloading',
      currentVersion: '1.5.0',
      targetVersion: '1.6.0',
      runtimeId: 'dev-old',
      progress: 64,
      error: null
    }
  ]
}

test.use({ seedTestRepo: false })

for (const theme of ['dark', 'light'] as const) {
  test(`compact update remotes disclosure, status bar and recovery (${theme})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 800 })
    await orcaPage.evaluate(
      async ({ theme, batch }) => {
        const state = window.__store!.getState()
        await state.updateSettingsOrThrow({ theme })
        await state.setIncludeRemotesInAppUpdate(true)
        window.__store!.setState({
          discoverAppUpdateRemotes: async () => undefined,
          updateReassuranceSeen: true,
          dismissedUpdateVersion: null,
          appUpdateCandidatesVersion: batch.targetVersion,
          appUpdateCandidates: batch.remotes.map((remote) => ({
            ...remote,
            phase: 'available',
            supportsPinnedInstall: true,
            liveTabCount: 1,
            liveLeafCount: 1,
            support: null
          }))
        })
        state.setUpdateStatus({ state: 'available', version: batch.targetVersion, changelog: null })
      },
      { theme, batch }
    )
    const card = orcaPage.getByRole('complementary')
    const checkbox = card.getByRole('checkbox', { name: 'Include remotes' })
    await expect(checkbox).toBeChecked()
    await card.getByRole('button', { name: 'Show remotes that will be updated' }).click()
    await expect(card.getByText('Build server', { exact: true })).toBeVisible()
    await expect(card.getByText('Dev box', { exact: true })).toBeVisible()
    await expect(checkbox).toBeChecked()
    await checkbox.click()
    await expect(checkbox).not.toBeChecked()
    await expect
      .poll(() =>
        orcaPage.evaluate(async () => (await window.api.ui.get()).includeRemotesInAppUpdate)
      )
      .toBe(false)
    await card.screenshot({
      path: testInfo.outputPath(`include-remotes-${theme}.png`),
      animations: 'disabled'
    })

    await orcaPage.evaluate((batch) => {
      window.__store!.setState({ appUpdateBatch: batch, appUpdateRunning: true })
      window
        .__store!.getState()
        .setUpdateStatus({ state: 'downloading', version: batch.targetVersion, percent: 70 })
    }, batch)
    await expect(card.getByRole('progressbar')).toHaveCount(1)
    await expect(card.getByText('Dev box', { exact: true })).toBeHidden()
    await card.screenshot({
      path: testInfo.outputPath(`compact-progress-${theme}.png`),
      animations: 'disabled'
    })
    await card.getByRole('button', { name: 'Show update details' }).click()
    await expect(card.getByText('Downloading… 64%', { exact: true })).toBeVisible()
    await expect(card.getByRole('progressbar')).toHaveCount(1)
    await card.screenshot({
      path: testInfo.outputPath(`expanded-progress-${theme}.png`),
      animations: 'disabled'
    })
    await card.getByRole('button', { name: 'Minimize update' }).click()
    await expect(card).toBeHidden()
    await orcaPage.evaluate(() =>
      window.__store!.getState().setUpdateStatus({ state: 'downloaded', version: '1.6.0' })
    )
    await expect(card).toBeHidden()
    await orcaPage.screenshot({
      path: testInfo.outputPath(`minimized-progress-${theme}.png`),
      animations: 'disabled'
    })
    await orcaPage
      .getByRole('button', { name: 'Updating Orca. Click to expand.', exact: true })
      .click()
    await expect(card.getByRole('progressbar')).toHaveCount(1)

    await orcaPage.evaluate(
      (batch) =>
        window.__store!.setState({
          appUpdateRunning: false,
          appUpdateBatch: {
            ...batch,
            stage: 'attention',
            remotes: batch.remotes.map((remote) =>
              remote.environmentId === 'dev'
                ? {
                    ...remote,
                    phase: 'not-confirmed',
                    error: 'The server has not reconnected yet.'
                  }
                : remote
            )
          }
        }),
      batch
    )
    await expect(
      orcaPage.getByRole('button', {
        name: 'Update needs attention. Click to expand.',
        exact: true
      })
    ).toBeVisible()
    await card.getByRole('button', { name: 'Show update details' }).click()
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Okay', exact: true })).toBeVisible()
    await expect(card.getByText(/These remotes stay flagged/)).toBeVisible()
    await card.screenshot({
      path: testInfo.outputPath(`remote-recovery-${theme}.png`),
      animations: 'disabled'
    })
    await orcaPage.evaluate(() => window.__store!.setState({ appUpdateBatch: null }))
  })
}
