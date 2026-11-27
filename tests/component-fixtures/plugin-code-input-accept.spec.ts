import { expect, test } from '@playwright/test'

// The unit tests stub execCommand and the popover; this runs the real popup and the native
// insertText, which trims to maxLength and keeps the edit on the textarea's undo stack.
const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

test('a suggestion accepted at maxLength is trimmed, emitted, and undone natively', async ({
  page
}) => {
  await page.goto('/fixtures.html?id=plugins/declarative/PluginDeclarativeCodeInput:atMaxLength')
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
  const field = page.getByRole('combobox', { name: 'Filter' })
  await expect(field).toHaveValue('to + x')

  await field.focus()
  await field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 2))
  await page.keyboard.press('Control+Space')
  const option = page.getByRole('option', { name: 'total' })
  await expect(option).toBeVisible()

  // A click must not take focus from the field, or the insertion would land nowhere.
  await option.click()
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(field).toBeFocused()
  // 'total' replaces 'to', but only 4 of its 5 characters fit in 8.
  await expect(field).toHaveValue('tota + x')
  await expect(page.locator('html')).toHaveAttribute('data-code-input-emitted', 'tota + x')
  expect(await field.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(4)

  await page.keyboard.press(undo)
  await expect(field).toHaveValue('to + x')
  await expect(page.locator('html')).toHaveAttribute('data-code-input-emitted', 'to + x')
})
