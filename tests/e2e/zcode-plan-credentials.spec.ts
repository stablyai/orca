import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

function selectPlan(home: string, site: 'zai' | 'bigmodel'): void {
  const root = path.join(home, '.zcode', 'v2')
  mkdirSync(root, { recursive: true })
  const providerId = `account:${site}-individual-coding-plan`
  writeFileSync(
    path.join(root, 'provider_config.json'),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId, modelId: 'GLM-test' }
      }
    })
  )
  writeFileSync(
    path.join(root, 'credentials.json'),
    JSON.stringify({
      [`account-provider:${providerId}:identity`]: 'synthetic-account',
      [`account-provider:coding-plan:${providerId}:account:synthetic-account:api-key`]: `synthetic-${site}-key`
    })
  )
}

test('Accounts recognizes the selected CLI plan and preserves a separately saved quota key', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  await electronApp.evaluate(() => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/api/monitor/usage/quota/limit')) {
        const key = new Headers(init?.headers).get('Authorization')
        const percentage =
          key === 'synthetic-zai-key' ? 12 : key === 'synthetic-bigmodel-key' ? 67 : 33
        return new Response(
          JSON.stringify({
            success: true,
            data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage }] }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return realFetch(input, init)
    }
  })
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsPage()
    state?.openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-zcode' })
  })
  const section = orcaPage.locator('#accounts-zcode')
  await expect(section).toBeVisible({ timeout: 30_000 })
  await expect(section.getByText('No GLM Coding Plan linked', { exact: true })).toBeVisible()
  await section.screenshot({ path: testInfo.outputPath('01-no-cli-plan.png') })

  selectPlan(home, 'zai')
  await orcaPage.evaluate(() => window.__store?.getState().refreshRateLimits())
  await expect(section.getByText('Using the ZCode CLI sign-in', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(section.getByText('12%', { exact: true })).toBeVisible()
  await section.screenshot({ path: testInfo.outputPath('02-cli-plan.png') })

  selectPlan(home, 'bigmodel')
  await orcaPage.evaluate(() => window.__store?.getState().refreshRateLimits())
  await expect(section.getByText('67%', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(section.getByText('12%', { exact: true })).toHaveCount(0)
  await section.screenshot({ path: testInfo.outputPath('03-selected-account.png') })

  await section.getByPlaceholder('Paste your GLM Coding Plan API key').fill('synthetic-saved-key')
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(section.getByText(/API key saved ·/)).toBeVisible({ timeout: 15_000 })
  await expect(section.getByText('33%', { exact: true })).toBeVisible({ timeout: 30_000 })
  const savedPath = path.join(home, '.orca', 'zcode-plan-api-key.enc')
  expect(existsSync(savedPath)).toBe(true)
  await section.screenshot({ path: testInfo.outputPath('04-saved-key-priority.png') })
  await section.getByRole('button', { name: 'Forget key', exact: true }).click()
  await expect(section.getByText('Using the ZCode CLI sign-in', { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(section.getByText('67%', { exact: true })).toBeVisible({ timeout: 30_000 })
  expect(existsSync(savedPath)).toBe(false)
})
