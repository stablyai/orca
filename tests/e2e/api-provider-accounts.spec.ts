import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

test('named API accounts use the existing Claude and Codex account pickers', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    window.__store.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
    window.__store.getState().openSettingsPage()
  })
  for (const agent of ['claude', 'codex'] as const) {
    const section = orcaPage.locator(`#accounts-${agent}`)
    await section.getByRole('button', { name: 'Add API account', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog')
    await dialog.getByLabel('Account name', { exact: true }).fill('Surplus')
    await dialog
      .getByLabel('API endpoint', { exact: true })
      .fill(`https://api.surplusintelligence.ai/${agent === 'claude' ? 'anthropic' : 'v1'}`)
    await dialog
      .getByLabel('Model', { exact: true })
      .fill(agent === 'claude' ? 'claude-opus-5.5' : 'gpt-6.1-sol')
    await dialog.getByLabel('API key', { exact: true }).fill('inf_cancelled_key')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await section.getByRole('button', { name: 'Add API account', exact: true }).click()
    await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('')
    await dialog.getByLabel('API key', { exact: true }).fill('inf_e2e_fake_key')
    await dialog.getByRole('button', { name: 'Save account', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(section.getByText('Surplus', { exact: true })).toBeVisible()
    const state = await orcaPage.evaluate(
      async (provider) =>
        window.api[provider === 'claude' ? 'claudeAccounts' : 'codexAccounts'].list(),
      agent
    )
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0].apiProvider?.label).toBe('Surplus')
    expect(JSON.stringify(state)).not.toContain('inf_e2e_fake_key')
    await section.getByRole('button', { name: /Surplus/ }).click()
    await expect(section.getByRole('button', { name: /Surplus/ })).toContainText('Active')
    await section.getByRole('button', { name: /^System default/ }).click()
    await expect(section.getByRole('button', { name: /^System default/ })).toContainText('Active')
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('surplus-accounts.png'), fullPage: true })
})

test('API accounts and selections survive an app restart', async (// oxlint-disable-next-line no-empty-pattern -- The restart helper owns both Electron launches.
{}, testInfo) => {
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | undefined
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate(async () => {
      for (const agent of ['claude', 'codex'] as const) {
        const api = window.api[agent === 'claude' ? 'claudeAccounts' : 'codexAccounts']
        const state = await api.addApiKey({
          label: `Saved ${agent}`,
          baseUrl: `https://api.example.test/${agent === 'claude' ? 'anthropic' : 'v1'}`,
          model: agent === 'claude' ? 'claude-opus-5.5' : 'gpt-6.1-sol',
          apiKey: 'inf_restart_fake_key'
        })
        await api.select({ accountId: state.accounts[0].id })
      }
    })
    await session.close(app)
    app = undefined
    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await second.page.evaluate(() => {
      window.__store.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
      window.__store.getState().openSettingsPage()
    })
    for (const agent of ['claude', 'codex'] as const) {
      const section = second.page.locator(`#accounts-${agent}`)
      await expect(
        section.getByRole('button', { name: new RegExp(`Saved ${agent}`) })
      ).toContainText('Active')
      await section.getByRole('button', { name: /^System default/ }).click()
      await expect(section.getByRole('button', { name: /^System default/ })).toContainText('Active')
    }
  } finally {
    await session.dispose(app)
  }
})
