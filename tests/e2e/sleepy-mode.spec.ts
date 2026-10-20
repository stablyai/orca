import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('Sleepy Mode covers the window from the status bar and wakes on a keypress', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)

  const beforePath = process.env.ORCA_SLEEPY_MODE_BEFORE_PROOF_PATH
  if (beforePath) {
    await orcaPage.screenshot({ path: beforePath })
  }

  const awakeStatus = orcaPage.getByRole('button', { name: /^Keep computer awake/ })
  await expect(awakeStatus).toBeVisible()
  await awakeStatus.click()

  await orcaPage.getByRole('menuitem', { name: 'Start Sleepy Mode' }).click()

  const scene = orcaPage.getByRole('dialog', { name: 'Sleepy Mode' })
  await expect(scene).toBeVisible()
  await expect(scene.getByText('No agents working')).toBeVisible()
  await expect(scene.getByText('Press any key to wake')).toBeVisible()

  const proofPath = process.env.ORCA_SLEEPY_MODE_PROOF_PATH
  if (proofPath) {
    await orcaPage.screenshot({ path: proofPath })
  }

  await orcaPage.keyboard.press('Space')
  await expect(scene).toBeHidden()
})
