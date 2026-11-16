import { expect, test, type Page } from '@playwright/test'

// The cloud build sheet's Agents row keeps the height it mounted with through every later state,
// so nothing below it moves. Measured layout shift is 0 (agent-accounts spec §5b, redesign §5).

type Model = Record<string, unknown> & { kind: string }

const ACCOUNT: Model = {
  kind: 'ready',
  covered: [
    { agent: 'claude', via: 'account' },
    { agent: 'codex', via: 'account' }
  ],
  label: 'nw@stably.ai',
  expiring: null
}
const BROWSER: Model = {
  kind: 'setup',
  agent: 'claude',
  setup: { phase: 'browser', startedAt: 0, canReopen: true },
  step: 1,
  of: 2
}
const DEVICE: Model = {
  kind: 'setup',
  agent: 'codex',
  setup: {
    phase: 'device',
    startedAt: 0,
    userCode: 'K7QF-2M9D',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: 0
  },
  step: 2,
  of: 2
}

// Every state the row can move to after mount, from either height class.
const LATER: readonly Model[] = [
  { kind: 'offer', agents: ['claude', 'codex'] },
  BROWSER,
  DEVICE,
  { kind: 'setup', agent: 'codex', setup: { phase: 'preparing', startedAt: 0 }, step: 2, of: 2 },
  { kind: 'setup', agent: 'claude', setup: { phase: 'saving' }, step: 1, of: 1 },
  { kind: 'failed', agent: 'claude', error: 'denied' },
  { kind: 'expired', agent: 'claude' },
  { kind: 'killSwitch', agent: 'claude', reason: 'paused' },
  { kind: 'killSwitch', agent: 'claude', reason: 'notOffered' },
  {
    kind: 'desktopKey',
    key: { id: 'k1', agent: 'claude', envName: 'ANTHROPIC_API_KEY', hint: 'x4Qa' }
  },
  { kind: 'error' },
  { ...ACCOUNT, expiring: 'claude' },
  ACCOUNT
]

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/fixtures.html?id=worktree-creation/VmBuildSheet:${id}`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  // Count every layout shift from here on, input or not.
  await page.evaluate(() => {
    document.documentElement.dataset.layoutShift = '0'
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const value = 'value' in entry && typeof entry.value === 'number' ? entry.value : 0
        const total = Number(document.documentElement.dataset.layoutShift) + value
        document.documentElement.dataset.layoutShift = String(total)
      }
    }).observe({ type: 'layout-shift', buffered: false })
  })
}

async function geometry(page: Page) {
  const row = await page.locator('[data-vm-build-cloud-agents-density]').boundingBox()
  // By attribute: an open menu hides the rest of the page from the accessibility tree.
  const logs = await page
    .locator('[data-vm-build-sheet] button[aria-controls]:not([aria-haspopup])')
    .boundingBox()
  if (!row || !logs) {
    throw new Error('Agents row or logs toggle has no bounds')
  }
  return { rowHeight: row.height, rowY: row.y, logsY: logs.y }
}

async function step(page: Page, model: Model): Promise<void> {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('orca-fixture-agents', { detail }))
  }, model)
  await expect(page.locator('[data-vm-build-cloud-agents]')).toHaveAttribute(
    'data-vm-build-cloud-agents',
    model.kind
  )
  // Two frames: layout and any shift entry land before the next measure.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

for (const [id, height] of [
  ['agentsSteppedFromLoading', 48],
  ['agentsSteppedFromReady', 32]
] as const) {
  test(`${id}: the row stays ${height}px and nothing below it moves`, async ({ page }) => {
    await open(page, id)
    const mounted = await geometry(page)
    expect(mounted.rowHeight).toBe(height)
    for (const model of LATER) {
      await step(page, model)
      expect(await geometry(page), `after ${model.kind}`).toEqual(mounted)
    }
    await expect(page.locator('html')).toHaveAttribute('data-layout-shift', '0')
  })
}

test('the open ⋯ menu overlays the sheet instead of pushing it', async ({ page }) => {
  await open(page, 'agentsSteppedFromReady')
  const before = await geometry(page)
  await page.getByRole('button', { name: 'Agent sign-in options' }).click()
  await expect(page.getByRole('menuitem', { name: 'Manage agent accounts…' })).toBeVisible()
  expect(await geometry(page)).toEqual(before)
})
