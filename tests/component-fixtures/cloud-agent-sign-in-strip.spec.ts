import { expect, test, type Page } from '@playwright/test'

// AC-1 (agent-sign-in redesign §8): across every strip state at one pane width, the strip, its text
// column, its actions slot and the terminal's top edge sit in exactly the same boxes.

const WIDE = [
  'needExpired',
  'needExpiredCodex',
  'killSwitch',
  'notOffered',
  'waiting',
  'code',
  'codePaste',
  'wrongAccount',
  'error',
  'errorOffline',
  'portBusy',
  'done'
] as const
const NARROW = ['needNarrow', 'waitingNarrow'] as const

async function boxes(page: Page, id: string) {
  await page.goto(`/fixtures.html?id=agent-sign-in-strip/CloudAgentSignInStrip:${id}`)
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const box = async (selector: string) => {
    const bounds = await page.locator(selector).first().boundingBox()
    if (!bounds) {
      throw new Error(`${selector} has no bounds in ${id}`)
    }
    return bounds
  }
  return {
    strip: await box('[data-cloud-sign-in-strip]'),
    text: await box('[data-strip-text]'),
    actions: await box('[data-strip-actions]'),
    terminalTop: (await box('pre')).y
  }
}

for (const [name, ids] of [
  ['wide', WIDE],
  ['narrow', NARROW]
] as const) {
  test(`${name}: every state keeps the same boxes, 56 px tall`, async ({ page }) => {
    const first = await boxes(page, ids[0])
    expect(first.strip.height).toBe(56)
    for (const id of ids.slice(1)) {
      expect(await boxes(page, id), id).toEqual(first)
    }
  })
}
