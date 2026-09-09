import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

for (const workspaceMode of ['existing', 'new_per_run'] as const) {
  test(`blank-terminal automation saves and runs in ${workspaceMode}`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => window.__store!.getState().openAutomationsPage())
    await orcaPage.getByRole('button', { name: 'Add new', exact: true }).click()

    const dialog = orcaPage.getByRole('dialog', { name: /^(Create|Edit) automation$/ })
    const agentPicker = dialog.locator('button[data-agent-combobox-root="true"]')
    await agentPicker.click()
    await orcaPage.getByRole('option', { name: 'Blank Terminal', exact: true }).click()
    await dialog.screenshot({
      path: testInfo.outputPath('blank-terminal-selected.png'),
      animations: 'disabled'
    })
    await expect(agentPicker).toContainText('Blank Terminal')
    await expect(dialog.getByRole('radio', { name: 'Reuse', exact: true })).toBeDisabled()

    const name = `Shell check ${workspaceMode}`
    const marker = 'ORCA_AUTOMATION_SHELL_COMMAND_OK'
    await dialog.getByRole('textbox', { name: 'Automation name' }).fill(name)
    if (workspaceMode === 'new_per_run') {
      await dialog.getByRole('radio', { name: 'New run', exact: true }).click()
    }
    const commandEditor = dialog.getByRole('textbox', { name: /^Shell command/ })
    await commandEditor.focus()
    await commandEditor.pressSequentially(`echo ${marker}`)
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).not.toBeVisible()

    await orcaPage.getByText(name, { exact: true }).click()
    await expect(orcaPage.getByText('Blank Terminal', { exact: true })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Edit automation', exact: true }).click()
    await expect(agentPicker).toContainText('Blank Terminal')
    await expect(dialog.locator('.view-lines')).toContainText(`echo ${marker}`)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    await orcaPage.getByRole('button', { name: 'Run Now', exact: true }).click()
    await orcaPage.getByRole('tab', { name: /^Runs/ }).click()
    await expect(orcaPage.getByText('1 run · 1 completed', { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await orcaPage.getByRole('tabpanel').getByRole('button', { name: /Done/ }).click()
    await expect(orcaPage.getByText(marker, { exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('blank-terminal-run.png') })
  })
}
