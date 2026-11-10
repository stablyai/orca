import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: () => 'localized built-in profile' }))

import { translateBrowserSessionProfileLabel } from './browser-session-profile-label'

describe('browser session profile labels', () => {
  it('preserves a custom profile named Default', () => {
    expect(translateBrowserSessionProfileLabel('Default', 'profile-123')).toBe('Default')
  })
  it('uses the ID when a non-default profile is missing', () => {
    expect(translateBrowserSessionProfileLabel(undefined, 'profile-123')).toBe('profile-123')
  })
})
