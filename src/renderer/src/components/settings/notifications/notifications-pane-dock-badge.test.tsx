// Upstream deleted components/settings/NotificationsPane.test.tsx when the pane moved into
// settings/notifications/; this file keeps only the #25191 platform-gating regression pins
// for the Show Dock Badge toggle (macOS only).
// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import { i18n } from '@/i18n/i18n'
import { NotificationsPane } from './NotificationsPane'

const { appPlatformHolder } = vi.hoisted(() => ({
  appPlatformHolder: { value: 'darwin' as NodeJS.Platform }
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => appPlatformHolder.value
}))

vi.mock('@/components/notifications/mac-notification-permission-card', () => ({
  useMacNotificationPermissionState: () => [null, vi.fn()],
  MacNotificationPermissionCard: () => null
}))
vi.mock('./NotificationHostToggles', () => ({ NotificationHostToggles: () => null }))
vi.mock('./NotificationSoundSection', () => ({ NotificationSoundSection: () => null }))

describe('NotificationsPane Show Dock Badge toggle', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('shows the Show Dock Badge toggle on macOS', () => {
    appPlatformHolder.value = 'darwin'
    const html = renderToStaticMarkup(
      <NotificationsPane settings={createGlobalSettingsFixture()} updateSettings={vi.fn()} />
    )

    expect(html).toContain('Show Dock Badge')
  })

  it('hides the Show Dock Badge toggle off macOS', () => {
    appPlatformHolder.value = 'win32'
    const html = renderToStaticMarkup(
      <NotificationsPane settings={createGlobalSettingsFixture()} updateSettings={vi.fn()} />
    )

    expect(html).not.toContain('Show Dock Badge')
  })
})
