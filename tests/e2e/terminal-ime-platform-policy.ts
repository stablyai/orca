import type { Page } from '@stablyai/playwright-test'

// Pin terminal IME policy through navigator.userAgent: printable forwarding on macOS/Linux, candidate guards on Linux, and keyCode 229 allowed on macOS/Linux.
// This selects renderer policy only; replay recorded traces for framework-specific ordering, which the UA override cannot simulate.
export type ImePlatformPolicy = 'mac' | 'windows' | 'linux'

const USER_AGENT_BY_POLICY: Record<ImePlatformPolicy, string> = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36',
  // Chromium reports X11 in both X11 and Wayland user agents; both trace types use this policy.
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/146 Safari/537.36'
}

export async function applyImePlatformPolicy(page: Page, policy: ImePlatformPolicy): Promise<void> {
  await page.addInitScript((userAgent) => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => userAgent,
      configurable: true
    })
  }, USER_AGENT_BY_POLICY[policy])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
}

/** Fails loudly if the override did not take, so a policy-scoped spec cannot pass on the wrong one. */
export async function expectImePlatformPolicy(
  page: Page,
  policy: ImePlatformPolicy
): Promise<void> {
  const observed = await page.evaluate(() => ({
    mac: navigator.userAgent.includes('Mac'),
    windows: navigator.userAgent.includes('Windows'),
    linux: navigator.userAgent.includes('Linux') && !/Android|CrOS/.test(navigator.userAgent)
  }))
  if (!observed[policy] || (policy !== 'mac' && observed.mac)) {
    throw new Error(`IME platform policy '${policy}' did not take: ${JSON.stringify(observed)}`)
  }
}
