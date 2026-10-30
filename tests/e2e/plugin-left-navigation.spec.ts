import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'

test('left-navigation panels open a main page, support history and revoke mounted content', async ({
  orcaPage
}) => {
  const pluginRoot = join(process.cwd(), 'examples/plugins/left-navigation')
  const frame = orcaPage.frameLocator('iframe[title="MRs"]')
  const iframe = orcaPage.locator('iframe[title="MRs"]')
  const nav = orcaPage.locator('[data-contextual-tour-target="sidebar-navigation"]')

  try {
    await orcaPage.evaluate(async () => {
      const settings = await window.api.settings.set({ showSkillsButton: true })
      window.__store?.setState({ settings })
    })
    await enableDevPlugins(orcaPage, [pluginRoot])
    const entry = nav.getByRole('button', { name: 'MRs', exact: true })
    await expect(entry).toBeVisible()
    await nav.getByRole('button', { name: 'Skills', exact: true }).click()
    await entry.focus()
    await entry.press('Enter')

    await expect(entry).toHaveAttribute('aria-current', 'page')
    await expect(orcaPage.getByRole('heading', { name: 'MRs', exact: true })).toBeVisible()
    await expect(frame.getByRole('button', { name: 'Check interaction' })).toBeVisible()
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    await frame.getByRole('button', { name: 'Check interaction' }).click()
    await expect(frame.getByRole('status')).toHaveText('Interaction received: 1')

    const bounds = await iframe.boundingBox()
    expect(bounds?.width).toBeGreaterThan(600)
    await orcaPage.getByRole('button', { name: 'Go back', exact: true }).click()
    await expect(iframe).toHaveCount(0)
    await orcaPage.getByRole('button', { name: 'Go forward', exact: true }).click()
    await expect(iframe).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Close plugin page' }).click()
    await expect(iframe).toHaveCount(0)
    await expect(orcaPage.getByRole('button', { name: 'Go forward', exact: true })).toBeEnabled()
    await orcaPage.getByRole('button', { name: 'Go forward', exact: true }).click()
    await expect(iframe).toBeVisible()

    const setRendererPluginSystem = (enabled: boolean) =>
      orcaPage.evaluate((next) => {
        const store = window.__store
        const settings = store?.getState().settings
        if (!store || !settings) {
          throw new Error('Settings not loaded')
        }
        store.setState({ settings: { ...settings, pluginSystemEnabled: next } })
      }, enabled)
    await setRendererPluginSystem(false)
    await expect(entry).toHaveCount(0)
    await expect(iframe).toHaveCount(0)
    await orcaPage.getByRole('button', { name: 'Go back', exact: true }).click()
    await expect(orcaPage.getByRole('button', { name: 'Go forward', exact: true })).toBeDisabled()
    await setRendererPluginSystem(true)
    await orcaPage.getByRole('button', { name: 'Go forward', exact: true }).click()
    await expect(iframe).toBeVisible()

    await disablePluginSystem(orcaPage)
    await expect(entry).toHaveCount(0)
    await expect(iframe).toHaveCount(0)
    await expect(orcaPage.getByText('This plugin panel is no longer available.')).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Close plugin page' }).click()
    await expect(orcaPage.getByText('This plugin panel is no longer available.')).toHaveCount(0)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
  }
})
