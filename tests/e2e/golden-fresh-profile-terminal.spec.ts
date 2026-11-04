import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

test.use({ dismissOnboarding: false, seedTestRepo: false })

async function completeOnboarding(page: Page): Promise<void> {
  const footer = page.locator('[data-onboarding-modal] footer')
  const heading = page.locator('[data-onboarding-modal]').getByRole('heading').first()
  for (let step = 0; step < 5; step += 1) {
    const title = await heading.innerText()
    await footer.getByRole('button', { name: /^Continue\b/ }).click()
    if (/Set up notifications/i.test(title)) {
      break
    }
    await expect(heading).not.toHaveText(title)
  }
  await expect(page.locator('[data-onboarding-overlay]')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: /Add a project/i })).toHaveCount(0)
}

test('fresh profile opens a live Home terminal @golden', async ({ electronApp, orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await expect(orcaPage.locator('#root')).toBeVisible()
  await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible()

  await completeOnboarding(orcaPage)
  const homePath = await electronApp.evaluate(({ app }) => app.getPath('home'))
  await expect(orcaPage.getByText('Home', { exact: true }).first()).toBeVisible()
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage, 30_000)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
  await expect.poll(() => orcaPage.evaluate((id) => window.api.pty.hasPty(id), ptyId)).toBe(true)

  const marker = `orca-e2e-fresh-${Date.now()}`
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.type(`echo ${marker}`)
  await orcaPage.keyboard.press('Enter')
  await expect
    .poll(async () => (await getTerminalContent(orcaPage)).split(marker).length - 1, {
      message: 'marker should appear in both the echoed command and command output'
    })
    .toBeGreaterThanOrEqual(2)

  const begin = `orca-cwd-begin-${Date.now()}`
  const end = `orca-cwd-end-${Date.now()}`
  const normalizePath = (value: string): string => {
    const normalized = value.trim().replaceAll('\\', '/')
    const withoutTrailingSeparator =
      normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
    return process.platform === 'win32'
      ? withoutTrailingSeparator.toLowerCase()
      : withoutTrailingSeparator
  }
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.type(`echo "${begin}$(pwd)${end}"`)
  await orcaPage.keyboard.press('Enter')
  await expect
    .poll(
      async () => {
        const content = await getTerminalContent(orcaPage)
        return [...content.matchAll(new RegExp(`${begin}(.*?)${end}`, 'gs'))].map((match) =>
          normalizePath(match[1].replace(/[\r\n]/g, ''))
        )
      },
      { message: 'fresh Home terminal should report exactly the home directory' }
    )
    .toContain(normalizePath(homePath))
})
