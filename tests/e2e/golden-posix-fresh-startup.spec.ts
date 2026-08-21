import { expect, test } from './helpers/mcode-app'

test.skip(process.platform === 'win32', 'POSIX fresh-startup golden; Windows has its own suite')

test.describe('POSIX fresh startup golden', () => {
  test.use({ dismissOnboarding: false, seedTestRepo: false })

  test('fresh profile reaches onboarding normally @posix-profile-index-golden', async ({
    mcodePage
  }) => {
    await expect(mcodePage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 30_000
    })
  })
})
