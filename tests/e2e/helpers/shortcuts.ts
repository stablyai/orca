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

/**
 * Press a Cmd/Ctrl shortcut using the platform-specific modifier key.
 *
 * Why: Orca binds shortcuts as Cmd on macOS and Ctrl on Linux/Windows. Using
 * a helper keeps the E2E suite aligned with the app's runtime shortcut logic
 * instead of hardcoding macOS-only key chords in each spec.
 */
export async function pressShortcut(
  page: Page,
  key: string,
  options: ShortcutOptions = {}
): Promise<void> {
  const parts = [await getModifierKey(page)]
  if (options.shift) {
    parts.push('Shift')
  }
  parts.push(key)
  await page.keyboard.press(parts.join('+'))
}
