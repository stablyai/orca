import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('automation editor exposes webhook verification without saving or triggering a run', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => window.__store!.getState().openAutomationsPage())
  const announcement = orcaPage.getByRole('button', { name: 'Maybe Later', exact: true })
  if (await announcement.isVisible().catch(() => false)) {
    await announcement.click()
  }
  await orcaPage.getByRole('button', { name: 'New Automation', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog.getByText('Webhook trigger', { exact: true })).toBeVisible()
  await dialog.getByText('Webhook trigger', { exact: true }).scrollIntoViewIfNeeded()
  await testInfo.attach('webhook-editor-off', {
    body: await dialog.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('webhook-editor-off.png')
    }),
    contentType: 'image/png'
  })
  await dialog.getByRole('radio', { name: 'On', exact: true }).click()
  await expect(dialog.getByPlaceholder('Save the automation to get its webhook URL.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy webhook URL', exact: true })).toBeDisabled()
  await dialog.getByRole('combobox').filter({ hasText: 'No verification' }).click()
  await orcaPage
    .getByRole('option', { name: 'HMAC SHA-256 (e.g. GitHub, Gitea)', exact: true })
    .click()
  const secret = dialog.getByPlaceholder('Shared secret', { exact: true })
  await expect(secret).toBeVisible()
  await dialog.getByRole('button', { name: 'Generate a new secret', exact: true }).click()
  await expect(secret).not.toHaveValue('')
  await expect(
    dialog.getByText(
      'Used to verify the request body signature (X-Hub-Signature-256 / X-Gitea-Signature).',
      { exact: true }
    )
  ).toBeVisible()
  await testInfo.attach('webhook-editor-hmac', {
    body: await dialog.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('webhook-editor-hmac.png')
    }),
    contentType: 'image/png'
  })
})
