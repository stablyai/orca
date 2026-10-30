import { translate } from '@/i18n/i18n'
import type { BrowserViewportPreset } from '../../../../../shared/browser-viewport-presets'

export function browserViewportPresetLabel(preset: BrowserViewportPreset): string {
  switch (preset.id) {
    case 'mobile-s':
      return translate('browser.viewport.mobile-s', 'Mobile S — 320 × 568')
    case 'mobile-m':
      return translate('browser.viewport.mobile-m', 'Mobile M — 375 × 667')
    case 'mobile-l':
      return translate('browser.viewport.mobile-l', 'Mobile L — 425 × 812')
    case 'tablet':
      return translate('browser.viewport.tablet', 'Tablet — 768 × 1024')
    case 'laptop':
      return translate('browser.viewport.laptop', 'Laptop — 1024 × 768')
    case 'laptop-l':
      return translate('browser.viewport.laptop-l', 'Laptop L — 1440 × 900')
    case 'desktop':
      return translate('browser.viewport.desktop', 'Desktop — 1920 × 1080')
  }
}
