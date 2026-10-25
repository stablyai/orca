import type { Page } from '@stablyai/playwright-test'

type ShortcutOptions = {
  shift?: boolean
}

const modifierKeyByPage = new WeakMap<Page, 'Meta' | 'Control'>()

async function getModifierKey(page: Page): Promise<'Meta' | 'Control'> {
  const cached = modifierKeyByPage.get(page)
  if (cached) {
    return cached
  }

  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  const modifierKey = isMac ? 'Meta' : 'Control'
  modifierKeyByPage.set(page, modifierKey)
  return modifierKey
}

// Use Cmd on macOS and Ctrl on Linux/Windows, matching runtime shortcuts.
export async function pressShortcut(
  page: Page,
  key: string,
  options: ShortcutOptions = {}
): Promise<void> {
  const parts: string[] = [await getModifierKey(page)]
  if (options.shift) {
    parts.push('Shift')
  }
  parts.push(key)
  await page.keyboard.press(parts.join('+'))
}
