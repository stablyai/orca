import { expect } from '@stablyai/playwright-test'

export async function verifySignInRecovery(page, url) {
  const button = (name) => page.getByRole('button', { name, exact: true })
  const transcript = page.locator('[aria-label="Transcript"]')
  const notice = page.getByRole('region', { name: 'Composer notice' })
  const announcement = page.locator('span[role="status"][aria-live="polite"]')
  const signIn = button('Sign in')
  const sent = page.locator('output[aria-label="Sent messages"]')
  const fixture = (action, value) =>
    page.evaluate(
      ({ action, value }) => {
        return window.signInFixture[action](value)
      },
      { action, value }
    )
  const pending = (key, count) =>
    expect.poll(async () => (await fixture('pending'))[key]).toBe(count)
  const load = async (surface) => {
    await page.goto(`${url}?sign-in&surface=${surface}`)
    await page.waitForFunction(() => Boolean(window.signInFixture), undefined, { timeout: 10_000 })
  }

  await load('managed')
  await pending('lookups', 1)
  await expect(signIn).toHaveCount(0)
  await fixture('rejectLookup')
  await button('Check again').click()
  await pending('lookups', 1)
  await fixture('resolveLookup', 'fixture-managed-account')
  await expect(signIn).toHaveCount(1)
  await signIn.focus()
  await expect(signIn).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(button('Signing in…')).toBeDisabled()
  await button('Replace failure').click()
  await pending('lookups', 1)
  await fixture('resolveLookup', 'fixture-managed-account')
  await fixture('finishManaged')
  await expect(announcement).toBeEmpty()
  await expect(signIn).toHaveCount(1)
  await pending('openTerminals', 0)

  await load('queue')
  await expect(transcript.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await signIn.click()
  await pending('openTerminals', 1)
  // A repeat press returns to the open login terminal instead of opening another.
  await signIn.click()
  await pending('shownTerminals', 1)
  await pending('openTerminals', 1)
  await fixture('leaveUnrelated')
  await pending('probes', 0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await pending('probes', 1)
  await fixture('leaveTerminal')
  await fixture('finishProbe', 'confirmed')
  await pending('probes', 1)
  await expect(announcement).toBeEmpty()
  await fixture('finishProbe', 'legacy')
  // An unconfirmed sign-in claims neither success nor failure.
  await expect(announcement).toBeEmpty()
  await expect(signIn).toHaveCount(1)
  await signIn.click()
  await pending('openTerminals', 2)
  await fixture('leaveTerminal')
  await pending('probes', 1)
  await fixture('finishProbe', 'confirmed')
  await expect(announcement).toHaveText('Signed in.')
  await expect(page.getByText('Keep the original message.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue(
    'Keep the unrelated draft.'
  )
  await expect(sent).toHaveText('0')
  await button('Send').click()
  await expect(sent).toHaveText('1')

  await load('transcript')
  const rowAction = transcript.getByRole('button', { name: 'Sign in', exact: true })
  const bannerAction = notice.getByRole('button', { name: 'Sign in', exact: true })
  await expect(rowAction).toBeVisible()
  await rowAction.focus()
  await expect(rowAction).toBeFocused()
  await transcript.evaluate((element) => {
    element.scrollTop = 80
  })
  await expect(bannerAction).toBeVisible()
  await expect(page.getByText('Fixture diagnostic')).toBeInViewport()
  await expect(signIn).toHaveCount(1)
  await transcript.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(rowAction).toBeVisible()
  await fixture('batch')
  await expect(bannerAction).toBeVisible()
  await button('Unmount chat').click()
  await expect(signIn).toHaveCount(0)
  await button('Remount chat').click()
  await expect(rowAction).toBeVisible()
  await expect(signIn).toHaveCount(1)

  await load('queue-clipped')
  await expect(bannerAction).toBeVisible()
  await expect(page.getByText('Keep the original message.')).toBeInViewport()
  await transcript.evaluate((element) => {
    element.scrollTop = 80
  })
  await expect(rowAction).toBeInViewport()
  await expect(signIn).toHaveCount(1)
  await transcript.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(bannerAction).toBeVisible()
  await expect(signIn).toHaveCount(1)

  await load('launch')
  const retry = notice.getByRole('button', { name: 'Retry', exact: true })
  await expect(bannerAction).toBeVisible()
  await expect(retry).toHaveCount(0)
  await bannerAction.click()
  await pending('openTerminals', 1)
  await expect(retry).toBeVisible()
  await expect(bannerAction).toBeVisible()
  await fixture('leaveTerminal')
  await pending('probes', 1)
  await fixture('finishProbe', 'unknown')
  await expect(announcement).toBeEmpty()
  await expect(bannerAction).toBeVisible()
  await retry.click()
  await pending('launchRetries', 1)
  await pending('openTerminals', 1)

  await load('older')
  await expect(page.getByText("Codex isn't signed in.")).toBeVisible()
  await expect(signIn).toHaveCount(0)
  await pending('lookups', 0)
  await pending('openTerminals', 0)
}
