import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { BrowserViewportPreset } from '../../../../../shared/browser-viewport-presets'

export function browserViewportPresetLabel(
  preset: BrowserViewportPreset,
  t: Translate = translate
): string {
  switch (preset.id) {
    case 'mobile-s':
      return t('browser.viewport.mobile-s', 'Mobile S — 320 × 568')
    case 'mobile-m':
      return t('browser.viewport.mobile-m', 'Mobile M — 375 × 667')
    case 'mobile-l':
      return t('browser.viewport.mobile-l', 'Mobile L — 425 × 812')
    case 'tablet':
      return t('browser.viewport.tablet', 'Tablet — 768 × 1024')
    case 'laptop':
      return t('browser.viewport.laptop', 'Laptop — 1024 × 768')
    case 'laptop-l':
      return t('browser.viewport.laptop-l', 'Laptop L — 1440 × 900')
    case 'desktop':
      return t('browser.viewport.desktop', 'Desktop — 1920 × 1080')
  }
}
