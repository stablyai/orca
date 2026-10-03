import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('Grok accounts render independent usage and persist account selection through IPC', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ app, net }) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const root = path.join(app.getPath('userData'), 'grok-accounts')
    const accounts = ['alice', 'bob'].map((id) => ({
      id,
      email: `${id}@example.com`,
      userId: id,
      teamId: null
    }))
    for (const account of accounts) {
      const home = path.join(root, account.id)
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(path.join(home, '.orca-grok-account'), account.id)
      fs.writeFileSync(
        path.join(home, 'auth.json'),
        JSON.stringify({
          'https://auth.x.ai::test-client': {
            key: account.id,
            user_id: account.id,
            email: account.email,
            expires_at: '2099-01-01T00:00:00Z'
          }
        })
      )
    }
    fs.writeFileSync(
      path.join(root, 'accounts.json'),
      JSON.stringify({ version: 1, accounts, activeAccountId: null })
    )
    const originalFetch = net.fetch
    net.fetch = async (url, options) => {
      if (String(url).startsWith('https://cli-chat-proxy.grok.com/v1/billing')) {
        const token = new Headers(options?.headers).get('authorization')
        return new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: token?.includes('alice') ? 16 : 12,
              currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2099-01-06T00:00:00Z' }
            }
          })
        )
      }
      return originalFetch(url, options)
    }
  })
  await orcaPage.evaluate(async () => {
    if (!window.__store) {
      throw new Error('Store is unavailable')
    }
    await window.__store.getState().updateSettings({ uiLanguage: 'en' })
    window.__store.getState().openSettingsPage()
    window.__store.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
  })
  const section = orcaPage.locator('#accounts-grok')
  await expect(section.getByText('alice@example.com', { exact: true })).toBeVisible()
  await expect(section.getByText(/Weekly.*16% used/)).toBeVisible()
  await expect(section.getByText(/Weekly.*12% used/)).toBeVisible()
  await section.getByRole('button', { name: 'Use account' }).first().click()
  await expect(section.getByText('Selected', { exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Use system login' })).toBeVisible()
  await section.getByRole('button', { name: 'Use account' }).click()
  const bobRow = section.getByText('bob@example.com', { exact: true }).locator('../..')
  await expect(bobRow.getByText('Selected', { exact: true })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('grok-managed-accounts.png') })
  await section.getByRole('button', { name: 'Use system login' }).click()
  await expect(section.getByRole('button', { name: 'Use account' })).toHaveCount(2)
})
