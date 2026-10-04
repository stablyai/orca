// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { NotificationsPane } from './NotificationsPane'

vi.mock('@/components/notifications/mac-notification-permission-card', () => ({
  useMacNotificationPermissionState: () => [null, vi.fn()],
  MacNotificationPermissionCard: () => null
}))
vi.mock('./NotificationHostToggles', () => ({ NotificationHostToggles: () => null }))
vi.mock('./NotificationSoundSection', () => ({ NotificationSoundSection: () => null }))

afterEach(() => vi.unstubAllGlobals())

it.each([true, false, undefined])(
  'toggles child unread from %s against pending settings before saves or rerenders',
  async (initial) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const settings = createGlobalSettingsFixture()
    settings.notifications.enabled = false
    settings.notifications.mutedNotificationSourceIds = ['ssh:a']
    if (initial === undefined) {
      delete settings.notifications.showChildWorktreeUnread
    } else {
      settings.notifications.showChildWorktreeUnread = initial
    }
    const writes: Partial<GlobalSettings>[] = []
    const resolveSaves: (() => void)[] = []
    const updateSettings = (update: Partial<GlobalSettings>): Promise<void> => {
      writes.push(update)
      return new Promise((resolve) => resolveSaves.push(resolve))
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(<NotificationsPane settings={settings} updateSettings={updateSettings} />)
      )
      const toggle = container.querySelector<HTMLButtonElement>(
        '[aria-label="Show unread badges for child workspaces"]'
      )
      expect(toggle).not.toBeNull()
      expect(toggle?.disabled).toBe(false)
      await act(async () => {
        toggle?.click()
        toggle?.click()
        toggle?.click()
      })
      const expected = initial === false ? [true, false, true] : [false, true, false]
      expect(writes).toEqual(
        expected.map((showChildWorktreeUnread) => ({
          notifications: { ...settings.notifications, showChildWorktreeUnread }
        }))
      )
    } finally {
      await act(async () => {
        resolveSaves.forEach((resolve) => resolve())
        root.unmount()
      })
    }
  }
)
