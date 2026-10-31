import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const diagnostic =
  'Close the other Orca instances (process IDs: 74451, 80932) before installing this update. Background orca serve instances also need to stop. Orca remains open; retry the update after closing them.'

test.use({ seedTestRepo: false })

for (const theme of ['dark', 'light'] as const) {
  test(`blocked update keeps the download ready and explains background servers (${theme})`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 800 })
    await orcaPage.evaluate(async (theme) => {
      await window.__store!.getState().updateSettingsOrThrow({ theme })
    }, theme)
    await expect(orcaPage.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /\blight\b/)

    await orcaPage.evaluate((message) => {
      window.__store!.setState({
        updateStatus: {
          state: 'error',
          version: '1.4.200',
          retryAction: 'install',
          message
        },
        dismissedUpdateVersion: null,
        updateCardCollapsed: false,
        updateReassuranceSeen: true
      })
    }, diagnostic)
    const card = orcaPage.getByRole('complementary', { name: /^Update (error|waiting)$/ })
    await expect(card.getByRole('heading', { name: 'Update Error' })).toBeVisible()
    await card.screenshot({
      path: testInfo.outputPath(`before-${theme}.png`),
      animations: 'disabled'
    })

    await orcaPage.evaluate((message) => {
      window.__store!.setState({
        updateStatus: {
          state: 'error',
          version: '1.4.200',
          retryAction: 'install',
          message,
          installBlock: {
            reason: 'running-instances',
            instances: [
              { pid: 74451, kind: 'browser' },
              { pid: 80932, kind: 'browser' }
            ]
          }
        }
      })
    }, diagnostic)
    await expect(card.getByRole('heading', { name: 'Your update is ready' })).toBeVisible()
    await expect(card.getByText('Background browser', { exact: true })).toHaveCount(2)
    await expect(card.getByText(/Connected devices will disconnect/)).toBeVisible()
    await expect(card.getByRole('button', { name: 'Download Manually' })).toHaveCount(0)
    await expect(card.getByText(diagnostic, { exact: true })).toHaveCount(0)
    const later = card.getByRole('button', { name: 'Later', exact: true })
    const bounds = await later.boundingBox()
    expect(bounds).not.toBeNull()
    const laterIsUnobstructed = await orcaPage.evaluate(
      ({ x, y }) => {
        return document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() === 'Later'
      },
      { x: bounds!.x + bounds!.width - 8, y: bounds!.y + bounds!.height / 2 }
    )
    expect(laterIsUnobstructed).toBe(true)
    await card.screenshot({
      path: testInfo.outputPath(`after-${theme}.png`),
      animations: 'disabled'
    })

    await card.getByRole('button', { name: 'Show details', exact: true }).click()
    await expect(card.getByText(diagnostic, { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Later', exact: true }).click()
    await expect(card).toBeHidden()
    expect(await orcaPage.evaluate(() => window.__store!.getState().updateStatus)).toMatchObject({
      state: 'error',
      version: '1.4.200',
      retryAction: 'install'
    })
    await orcaPage
      .getByRole('button', {
        name: 'Update waiting for other Orca instances. Click to expand.',
        exact: true
      })
      .click()
    await expect(card).toBeVisible()

    // Exercise the real preload retry path without applying an update to the test app.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('updater:quitAndInstall')
      ipcMain.handle('updater:quitAndInstall', (event) => {
        event.sender.send('updater:status', {
          state: 'downloaded',
          version: '1.4.200',
          installing: true
        })
      })
    })
    await card.getByRole('button', { name: 'Retry installation', exact: true }).click()
    const preparing = orcaPage.getByRole('heading', { name: 'Preparing your update', exact: true })
    await expect(preparing).toBeVisible()
    await expect(
      orcaPage.getByRole('button', { name: 'Restart to Update', exact: true })
    ).toHaveCount(0)
    await orcaPage.getByRole('complementary').screenshot({
      path: testInfo.outputPath(`preparing-${theme}.png`),
      animations: 'disabled'
    })
    for (const state of ['before', 'after', 'preparing']) {
      await testInfo.attach(`${state}-${theme}`, {
        path: testInfo.outputPath(`${state}-${theme}.png`),
        contentType: 'image/png'
      })
    }
    for (const [reason, guidance] of [
      ['busy', 'Wait a moment, then retry. Your downloaded update is ready.'],
      [
        'unresponsive',
        'Stop it from the terminal or service that started it, then retry. Connected devices will disconnect.'
      ]
    ] as const) {
      await orcaPage.evaluate((reason) => {
        window.__store!.setState({
          updateStatus: {
            state: 'error',
            version: '1.4.200',
            retryAction: 'install',
            message: 'Diagnostic',
            installBlock: { reason, instances: [{ pid: 80932, kind: 'server' }] }
          },
          updateCardCollapsed: true
        })
      }, reason)
      await orcaPage
        .getByRole('button', { name: 'Update waiting for other Orca instances. Click to expand.' })
        .hover()
      const tooltip = orcaPage.getByRole('tooltip', { name: guidance, exact: true })
      await expect(tooltip).toHaveText(guidance)
      const tooltipProof = testInfo.outputPath(`tooltip-${reason}-${theme}.png`)
      await tooltip.screenshot({ path: tooltipProof, animations: 'disabled' })
      await testInfo.attach(`tooltip-${reason}-${theme}`, {
        path: tooltipProof,
        contentType: 'image/png'
      })
      await orcaPage.mouse.move(0, 0)
      await expect(tooltip).toBeHidden()
    }
    await orcaPage.evaluate(async (message) => {
      await window.__store!.getState().updateSettingsOrThrow({ uiLanguage: 'es' })
      window.__store!.setState({
        updateCardCollapsed: false,
        updateStatus: {
          state: 'error',
          version: '1.4.200',
          retryAction: 'install',
          message,
          installBlock: {
            reason: 'running-instances',
            instances: [
              { pid: 74451, kind: 'browser' },
              { pid: 80932, kind: 'browser' }
            ]
          }
        }
      })
    }, diagnostic)
    const spanishCard = orcaPage.getByRole('complementary').filter({
      has: orcaPage.getByRole('heading', { name: 'Tu actualización está lista', exact: true })
    })
    await expect(spanishCard.getByText('Navegador en segundo plano', { exact: true })).toHaveCount(
      2
    )
    await expect(
      spanishCard.getByRole('button', { name: 'Reintentar instalación', exact: true })
    ).toBeVisible()
    await expect(spanishCard.getByRole('button', { name: 'Más tarde', exact: true })).toBeVisible()
    const spanishProof = testInfo.outputPath(`after-es-${theme}.png`)
    await spanishCard.screenshot({ path: spanishProof, animations: 'disabled' })
    await testInfo.attach(`after-es-${theme}`, { path: spanishProof, contentType: 'image/png' })
  })
}
