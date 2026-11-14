import { expect, test, type Page } from '@playwright/test'

async function pixels(page: Page, sample: string): Promise<Buffer> {
  return page.locator(`[data-paint-sample="${sample}"]`).screenshot()
}

test('material reaches chat without changing the neighboring terminal or exposing covered content', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=native-chat/appearance/NativeChatBackdrop:material&theme=dark')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready')
  const backdrop = page.locator('[data-test-backdrop]')
  await backdrop.evaluate((element) => (element.style.background = 'white'))
  const neighbor = await pixels(page, 'neighbor')
  await page.getByRole('button', { name: 'Toggle split chat' }).click()
  expect(await pixels(page, 'neighbor')).toEqual(neighbor)

  const samples = ['single', 'split', 'structured']
  const lightBare = await pixels(page, 'bare')
  const light = await Promise.all(samples.map((sample) => pixels(page, sample)))
  for (const painted of light) {
    expect(painted.equals(lightBare)).toBe(false)
  }
  await backdrop.evaluate((element) => (element.style.background = 'black'))
  const darkBare = await pixels(page, 'bare')
  for (const [index, sample] of samples.entries()) {
    const painted = await pixels(page, sample)
    expect(painted.equals(light[index])).toBe(false)
    expect(painted.equals(darkBare)).toBe(false)
  }

  const covered = await pixels(page, 'split')
  const neighborDark = await pixels(page, 'neighbor')
  await page.locator('[data-terminal-ink]').evaluateAll((elements) => {
    for (const element of elements) {
      if (element instanceof HTMLElement) {
        element.style.background = 'red'
      }
    }
  })
  expect(await pixels(page, 'split')).toEqual(covered)
  expect((await pixels(page, 'neighbor')).equals(neighborDark)).toBe(false)
})
