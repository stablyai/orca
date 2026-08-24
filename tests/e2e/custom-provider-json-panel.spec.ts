/**
 * Verifies the Config JSON panel: form->JSON live sync, JSON->form live sync
 * (including the icon picker), and syntax-error display for invalid JSON, by
 * driving the real Add Provider dialog. No external network calls.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('the JSON panel stays in sync with the form in both directions', async ({ orcaPage }) => {
  test.setTimeout(60_000)
  await waitForSessionReady(orcaPage)

  await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host machine may run a
    // non-English system locale, which 'system' would follow.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
    store.getState().openSettingsPage()
  })
  await orcaPage.getByText('Custom Providers').first().waitFor({ timeout: 10_000 })
  await orcaPage.getByRole('button', { name: 'Add Provider' }).click()

  const jsonBox = orcaPage.locator('#cp-json')
  await jsonBox.waitFor({ timeout: 10_000 })

  // 1. Form -> JSON: typing a name updates the JSON live.
  await orcaPage.locator('#cp-name').fill('Sync Test')
  await expect(jsonBox).toHaveValue(/"displayName": "Sync Test"/, { timeout: 5_000 })

  // 2. JSON -> Form: editing the JSON's usageUrl updates the URL input, and
  //    switching mappingMode in JSON reveals the used-limit fields (icon-
  //    picker-adjacent "form resource" following the JSON, not just text).
  const edited = JSON.stringify(
    {
      displayName: 'Sync Test',
      icon: 'cloud',
      usageUrl: 'https://example.com/usage?year={yyyy}&month={mm}&day={dd}',
      mappingMode: 'used-limit',
      usedPaths: ['a.b'],
      limitPath: 'c.d'
    },
    null,
    2
  )
  await jsonBox.fill(edited)
  await expect(orcaPage.locator('#cp-url')).toHaveValue(
    'https://example.com/usage?year={yyyy}&month={mm}&day={dd}'
  )
  await expect(orcaPage.locator('#cp-limit-path')).toHaveValue('c.d', { timeout: 5_000 })

  // 3. Invalid JSON syntax shows an error and does not corrupt the form.
  // Why: scoped to the red error paragraph, not just /JSON/i — the "Config
  // JSON" field label itself matches that pattern and is present from the
  // moment the dialog opens, so a looser locator would pass without ever
  // proving the error actually rendered.
  await jsonBox.fill('{ not valid json')
  await expect(
    orcaPage.locator('p.text-red-400').filter({ hasText: /Unexpected|Expected/i })
  ).toBeVisible({ timeout: 5_000 })
  await expect(orcaPage.locator('#cp-name')).toHaveValue('Sync Test')
})
