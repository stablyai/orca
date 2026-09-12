import type { Page } from '@stablyai/playwright-test'

/**
 * Pins the renderer's IME ownership policy to one platform, from any runner.
 *
 * Every platform-dependent IME decision in the terminal reads `navigator.userAgent` and nothing
 * else — the forwarder that owns printable keydowns installs only when the UA reports macOS, the
 * candidate-key guards only when it reports desktop Linux, and the standalone `keyCode 229`
 * keydown reaches xterm on macOS and Linux but not on Windows. Overriding the UA is therefore the
 * whole platform decision, which is what lets the Windows and Linux shapes run headless on the
 * Linux CI shards instead of needing three runners.
 *
 * What it does NOT simulate is the input framework itself. That comes from the recorded traces
 * replayed against the pinned policy, because the frameworks disagree on ordering in ways no
 * hand-authored sequence would have predicted.
 */
export type ImePlatformPolicy = 'mac' | 'windows' | 'linux'

const USER_AGENT_BY_POLICY: Record<ImePlatformPolicy, string> = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36',
  // X11 rather than Wayland in the UA string: Chromium reports the same token for both, so the
  // Wayland traces run under this policy too.
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
