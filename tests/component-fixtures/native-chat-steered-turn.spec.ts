import { expect, test, type Locator, type Page } from '@playwright/test'

// A turn the person wrote into mid-turn, in the real fixture renderer: each message they sent carries
// its own stretch's bar below it, only the newest stretch counts live, and every caret opens only
// its own stretch, by pointer and by keyboard.

const LOAD_TIMEOUT = 30_000
const BARS = '[data-native-chat-turn-status]'

const FIRST_STRETCH = ['orca orchestration check --json']
const AFTER_FOLLOW_UP = ['ls ~/transcripts']
const AFTER_AGAIN = ['tail -n 200 worker.log']

async function open(page: Page, variant: string): Promise<void> {
  await page.goto(
    `/fixtures.html?id=native-chat/conversation/turns/NativeChatSteeredTurn:${variant}`
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: LOAD_TIMEOUT
  })
  await expect(page.locator(BARS).first()).toBeVisible({ timeout: LOAD_TIMEOUT })
}

const bubble = (page: Page, text: string): Locator => page.getByText(text, { exact: false }).first()

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box!.y
}

/** Each bar sits right where it belongs: between the message above it and the one below. */
async function expectBarsBetween(page: Page, order: (Locator | string)[]): Promise<void> {
  const tops: number[] = []
  for (const item of order) {
    tops.push(await top(typeof item === 'string' ? bubble(page, item) : item))
  }
  expect(tops).toEqual([...tops].sort((a, b) => a - b))
}

async function expectShown(page: Page, commands: string[], shown: boolean): Promise<void> {
  for (const command of commands) {
    await expect(page.getByText(command, { exact: true })).toHaveCount(shown ? 1 : 0)
  }
}

test('a running turn with two messages written into it', async ({ page }) => {
  await open(page, 'runningWithTwoFollowUps')
  const bars = page.locator(BARS)
  await expect(bars).toHaveCount(3)
  await expect(bars.nth(0)).toHaveText(/^R?Worked for 6m 14s$/)
  await expect(bars.nth(1)).toHaveText(/^R?Continued for 26s$/)
  await expect(bars.nth(2)).toHaveText(/^R?Working for \d+s$/)
  await expect(bars.nth(2)).toHaveAttribute('data-native-chat-turn-status', 'active')
  await expect(page.getByText(/^Working for/)).toHaveCount(1)
  await expectBarsBetween(page, [
    'The release scan took 6 hours',
    bars.nth(0),
    'Debug deeply',
    bars.nth(1),
    'Also check the worker logs',
    bars.nth(2),
    page.getByText('Working…')
  ])

  const carets = page.locator('button[data-native-chat-turn-status="settled"]')
  await expect(carets).toHaveCount(2)
  await expectShown(page, FIRST_STRETCH, false)
  await expectShown(page, AFTER_FOLLOW_UP, false)
  await expectShown(page, AFTER_AGAIN, true)

  await carets.nth(0).click()
  await expect(carets.nth(0)).toHaveAttribute('aria-expanded', 'true')
  await expect(carets.nth(1)).toHaveAttribute('aria-expanded', 'false')
  await expectShown(page, FIRST_STRETCH, true)
  await expectShown(page, AFTER_FOLLOW_UP, false)

  await carets.nth(1).focus()
  await page.keyboard.press('Enter')
  await expect(carets.nth(1)).toHaveAttribute('aria-expanded', 'true')
  await expectShown(page, AFTER_FOLLOW_UP, true)

  await carets.nth(0).click()
  await expect(carets.nth(0)).toHaveAttribute('aria-expanded', 'false')
  await expectShown(page, FIRST_STRETCH, false)
  await expectShown(page, AFTER_FOLLOW_UP, true)
})

test('the same turn once settled', async ({ page }) => {
  await open(page, 'settledWithTwoFollowUps')
  const bars = page.locator(BARS)
  await expect(bars).toHaveCount(3)
  await expect(bars.nth(0)).toHaveText(/^R?Worked for 10m 0s$/)
  await expect(bars.nth(1)).toHaveText(/^R?Continued for 26s$/)
  await expect(bars.nth(2)).toHaveText(/^R?Continued for 3m 20s$/)
  await expect(page.getByText(/^Working/)).toHaveCount(0)
  await expectBarsBetween(page, [
    'The release scan took 6 hours',
    bars.nth(0),
    'Debug deeply',
    bars.nth(1),
    'Also check the worker logs',
    bars.nth(2),
    'Both workers hit a usage limit'
  ])

  const carets = page.locator('button[data-native-chat-turn-status="settled"]')
  await expect(carets).toHaveCount(3)
  const stretches = [FIRST_STRETCH, AFTER_FOLLOW_UP, AFTER_AGAIN]
  for (const commands of stretches) {
    await expectShown(page, commands, false)
  }
  // Each caret opens only its own stretch: pointer for the first two, keyboard for the last.
  for (const [index, commands] of stretches.entries()) {
    if (index < 2) {
      await carets.nth(index).click()
    } else {
      await carets.nth(index).focus()
      await page.keyboard.press('Space')
    }
    await expect(carets.nth(index)).toHaveAttribute('aria-expanded', 'true')
    await expectShown(page, commands, true)
    for (const later of stretches.slice(index + 1)) {
      await expectShown(page, later, false)
    }
  }
  // Every tool call of the turn, before and after each message, is now drawn.
  await expectShown(page, [...FIRST_STRETCH, ...AFTER_FOLLOW_UP, ...AFTER_AGAIN], true)
  await carets.nth(1).focus()
  await page.keyboard.press('Enter')
  await expect(carets.nth(1)).toHaveAttribute('aria-expanded', 'false')
  await expectShown(page, AFTER_FOLLOW_UP, false)
  await expectShown(page, [...FIRST_STRETCH, ...AFTER_AGAIN], true)
})

test('a running turn whose loaded tail starts on the person’s message', async ({ page }) => {
  await open(page, 'runningFromFollowUp')
  const bars = page.locator(BARS)
  await expect(bars).toHaveCount(2)
  await expect(bars.nth(0)).toHaveText(/^R?Worked for 6m 14s$/)
  await expect(bars.nth(1)).toHaveText(/^R?Working for \d+s$/)
  await expectBarsBetween(page, [bars.nth(0), 'Debug deeply', bars.nth(1)])
})
