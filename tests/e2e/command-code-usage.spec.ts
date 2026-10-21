import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Why: the CLI's own /usage overlay reads these four endpoints; the fixture
// answers them so the spec never touches the real Command Code API.
const SYNTHETIC_KEY = 'synthetic-command-code-key'

function writeCommandCodeLogin(home: string): void {
  const dir = path.join(home, '.commandcode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({ apiKey: SYNTHETIC_KEY, userId: 'e2e-user', userName: 'e2e-user' })
  )
}

test('Accounts and the status bar show Command Code credits and usage windows', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))

  await electronApp.evaluate(({ net }) => {
    const fakeResponse = (url: string): Response | null => {
      if (!url.includes('/alpha/')) {
        return null
      }
      if (url.includes('/alpha/whoami')) {
        return new Response(
          JSON.stringify({
            success: true,
            user: { id: 'e2e-user', name: 'E2E', email: 'e2e@example.com', userName: 'e2e-user' },
            org: null
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url.includes('/alpha/billing/credits')) {
        return new Response(
          JSON.stringify({
            credits: { monthlyCredits: 60, purchasedCredits: 10, freeCredits: 0 },
            windowLimits: {
              limited: true,
              fiveHour: { used: 7, cap: 14, exceeded: false, resetAt: 1_792_329_294_012 },
              weekly: { used: 7, cap: 35, exceeded: false, resetAt: 1_792_916_094_012 }
            },
            sandboxAccess: false,
            sandboxMinutes: { usedMinutes: 0, limitMinutes: 0, resetAt: 1_793_491_200_000 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url.includes('/alpha/billing/subscriptions')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              status: 'active',
              planId: 'individual-goat',
              currentPeriodStart: '2026-10-18T08:14:41.000Z',
              currentPeriodEnd: '2026-11-18T08:14:41.000Z'
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url.includes('/alpha/usage/summary')) {
        return new Response(JSON.stringify({ totalCost: 30, totalCount: 36 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return null
    }
    // Why: the desktop reads usage through the Chromium-backed client, so the
    // stub has to replace net.fetch itself, not the Node global.
    const realNetFetch = net.fetch.bind(net)
    const patched = async (
      input: string | URL,
      init?: Parameters<typeof net.fetch>[1]
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.href
      return fakeResponse(url) ?? realNetFetch(input, init)
    }
    Object.assign(net, { fetch: patched })
  })

  // No CLI login yet: the section explains how to sign in and hides the numbers.
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsPage()
    state?.openSettingsTarget({
      pane: 'accounts',
      repoId: null,
      sectionId: 'accounts-command-code'
    })
  })
  const section = orcaPage.locator('#accounts-command-code')
  await expect(section).toBeVisible({ timeout: 30_000 })
  await expect(section.getByText('Not signed in', { exact: true })).toBeVisible()
  // Why: refresh is the step the copy asks for after `cmd login`, so it must be
  // clickable while no credential is known yet.
  await expect(section.getByRole('button', { name: 'Refresh usage' })).toBeEnabled()
  await section.screenshot({ path: testInfo.outputPath('01-not-signed-in.png') })

  writeCommandCodeLogin(home)
  await orcaPage.evaluate(() => window.__store?.getState().refreshRateLimits())

  await expect(section.getByText('Signed in', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(section.getByText('50%', { exact: true })).toBeVisible()
  await expect(section.getByText('20%', { exact: true })).toBeVisible()
  await expect(section.getByText('30%', { exact: true })).toBeVisible()
  await expect(section.getByText('Weekly', { exact: false })).toBeVisible()
  await expect(section.getByText('Monthly', { exact: false })).toBeVisible()
  await expect(section.getByText('70 credits available', { exact: true })).toBeVisible()
  await expect(section.getByText('Plan: GOAT', { exact: true })).toBeVisible()
  await section.screenshot({ path: testInfo.outputPath('02-accounts.png') })

  const state = await orcaPage.evaluate(() => {
    const rateLimits = window.__store?.getState().rateLimits.commandCode
    return {
      status: rateLimits?.status ?? null,
      planType: rateLimits?.planType ?? null,
      session: rateLimits?.session?.usedPercent ?? null,
      weekly: rateLimits?.weekly?.usedPercent ?? null,
      monthly: rateLimits?.monthly?.usedPercent ?? null
    }
  })
  expect(state).toMatchObject({
    status: 'ok',
    planType: 'GOAT',
    session: 50,
    weekly: 20,
    monthly: 30
  })

  const chip = orcaPage.locator('[data-usage-chip="command-code"]')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip).toContainText('50%')
  await orcaPage.screenshot({ path: testInfo.outputPath('03-status-bar.png') })
})
