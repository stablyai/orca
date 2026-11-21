import { expect, test, type Page } from '@playwright/test'

async function open(page: Page, fixture: string, theme = 'dark'): Promise<void> {
  await page.goto(
    `/fixtures.html?id=native-chat/host-access/NativeChatEmptyState:${fixture}&theme=${theme}`
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 90_000
  })
}

for (const theme of ['dark', 'light']) {
  test(`a short welcome scrolls independently and leaves the composer usable (${theme})`, async ({
    page
  }) => {
    await open(page, 'longPurpose', theme)
    const pane = page.locator('[data-welcome-fixture]')
    const welcome = pane.getByRole('region')
    const editor = pane.getByRole('textbox')
    await expect(welcome).not.toHaveAccessibleName('')
    const paneBox = (await pane.boundingBox())!
    const composer = pane.locator('[data-native-chat-composer-scope]')
    const composerBox = (await composer.boundingBox())!
    expect(paneBox.width).toBe(817)
    expect(paneBox.height).toBe(225)
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(paneBox.y + 225)
    await expect(pane.locator('[data-clearing] p').first()).toBeInViewport({ ratio: 1 })

    await welcome.focus()
    await page.keyboard.press('Home')
    expect(
      await welcome.evaluate(
        (node) =>
          node.firstElementChild!.getBoundingClientRect().top >= node.getBoundingClientRect().top
      )
    ).toBe(true)
    await page.keyboard.press('End')
    await expect
      .poll(() =>
        welcome.evaluate(
          (node) =>
            node.scrollTop > 0 &&
            node.querySelector('p:last-child')!.getBoundingClientRect().bottom <=
              node.getBoundingClientRect().bottom
        )
      )
      .toBe(true)

    await page.keyboard.press('Tab')
    await expect(editor).toBeFocused()
    await page.keyboard.type('Draft for review')
    await expect(editor).toHaveText('Draft for review')
    await page.keyboard.press('Shift+Tab')
    await expect(welcome).toBeFocused()
    expect(await composer.boundingBox()).toEqual(composerBox)
  })
}

test('a fitting welcome adds no tab stop, and a growing composer makes it scrollable', async ({
  page
}) => {
  await open(page, 'ordinary')
  await expect(page.getByRole('region')).toHaveCount(0)
  await page.keyboard.press('Tab')
  const editor = page.getByRole('textbox')
  await expect(editor).toBeFocused()
  await page.locator('[data-welcome-fixture]').evaluate((node) => {
    node.style.height = '340px'
  })
  await editor.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8')
  await expect(page.getByRole('region')).toHaveCount(1)
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('region')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(editor).toBeFocused()
  await page.locator('[data-welcome-fixture]').evaluate((node) => {
    node.style.height = '225px'
  })
  await expect(page.getByRole('region')).toHaveCount(0)
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('[data-clearing] :focus')).toHaveCount(0)
  await page.keyboard.press('Tab')
  await expect(editor).toBeFocused()
  await editor.fill('')
  await expect(page.getByRole('region')).toHaveCount(1)
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('region')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(editor).toBeFocused()
})
