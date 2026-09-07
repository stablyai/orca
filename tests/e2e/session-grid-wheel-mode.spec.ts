import { writeFile } from 'node:fs/promises'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('the wheel selector offers Focus and retains the selected mode', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({ uiLanguage: 'en' })
    state.openSessionsPage()
  })

  const workspacePicker = orcaPage.getByTestId('session-grid-workspace-picker')
  await expect(workspacePicker).toContainText('All workspaces')
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'es' })
  })
  await expect(workspacePicker).toContainText('Todos los espacios')
  await expect(orcaPage.getByRole('heading', { name: 'No hay sesiones activas' })).toBeVisible()
  for (const label of ['Todos', 'Te necesita', 'Trabajando', 'Finalizado', 'Inactivo']) {
    await expect(
      orcaPage.getByTestId('session-grid-state-chip').filter({ hasText: label })
    ).toHaveCount(1)
  }
  await orcaPage.getByTestId('session-grid-new-session').click()
  await expect(orcaPage.getByPlaceholder('Buscar espacios de trabajo…')).toBeVisible()
  await orcaPage.keyboard.press('Escape')

  const trigger = orcaPage.getByTestId('session-grid-view-menu')
  await trigger.click()
  const menu = orcaPage.locator('[data-slot="dropdown-menu-content"]')
  await expect(menu.getByText('Rueda sobre terminales', { exact: true })).toBeVisible()
  for (const label of ['Fila por fila', 'Página por página', 'Desplazamiento libre']) {
    await expect(menu.getByRole('menuitemradio', { name: label, exact: true })).toBeVisible()
  }
  const wheelModes = menu.locator('[data-slot="dropdown-menu-radio-group"]').last()
  await expect(wheelModes.getByRole('menuitemradio')).toHaveCount(3)
  const focus = wheelModes.getByRole('menuitemradio', { name: /^Según foco/ })
  await expect(focus).toHaveAttribute('aria-checked', 'true')
  await expect(wheelModes.getByRole('menuitemradio', { name: /^Auto/ })).toHaveCount(0)

  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = testInfo.outputPath('wheel-modes.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  await testInfo.attach('wheel-modes', {
    path: screenshotPath,
    contentType: 'image/png'
  })
  await cdp.detach()

  await wheelModes.getByRole('menuitemradio', { name: /^Cuadrícula/ }).click()
  await expect(menu).toBeHidden()
  await trigger.click()
  await expect(wheelModes.getByRole('menuitemradio', { name: /^Cuadrícula/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await focus.click()
  await expect(menu).toBeHidden()
  await trigger.click()
  await expect(focus).toHaveAttribute('aria-checked', 'true')
})
