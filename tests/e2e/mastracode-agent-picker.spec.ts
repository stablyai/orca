import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ dismissOnboarding: false, seedTestRepo: false })

test('offers Mastra Code as a default agent', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible()

  await orcaPage.getByText(/Show \d+ more agents/).click()
  const mastraCode = orcaPage.getByRole('button', { name: /Mastra Code\s+mastracode/i })

  await expect(mastraCode).toBeVisible()
  await expect(mastraCode).toHaveAttribute('aria-pressed', 'false')
  await mastraCode.click()
  await expect(mastraCode).toHaveAttribute('aria-pressed', 'true')
})
