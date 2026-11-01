import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'

import { NotificationsPane, sendNotificationSettingsTestNotification } from './NotificationsPane'

const { toastError, toastMessage, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
    message: toastMessage,
    success: toastSuccess
  }
}))

const { appPlatformHolder } = vi.hoisted(() => ({
  appPlatformHolder: { value: 'darwin' as NodeJS.Platform }
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => appPlatformHolder.value
}))

function createSettings(): GlobalSettings {
  return createGlobalSettingsFixture({
    notifications: {
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: true,
      showDockBadge: true,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 50,
      mutedNotificationSourceIds: [],
      notifyHiddenWorkspaces: false
    }
  })
}

describe('NotificationsPane', () => {
  beforeEach(() => {
    toastError.mockClear()
    toastMessage.mockClear()
    toastSuccess.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the Show Dock Badge toggle on macOS', () => {
    appPlatformHolder.value = 'darwin'
    const html = renderToStaticMarkup(
      <NotificationsPane settings={createSettings()} updateSettings={vi.fn()} />
    )

    expect(html).toContain('Show Dock Badge')
  })

  it('hides the Show Dock Badge toggle off macOS', () => {
    appPlatformHolder.value = 'win32'
    const html = renderToStaticMarkup(
      <NotificationsPane settings={createSettings()} updateSettings={vi.fn()} />
    )

    expect(html).not.toContain('Show Dock Badge')
  })

  it('uses native main-process delivery even when renderer permission is stale denied on macOS', async () => {
    const notifications = {
      getPermissionStatus: vi.fn(async () => ({
        supported: true,
        platform: 'darwin' as NodeJS.Platform,
        requested: true
      })),
      dispatch: vi.fn(async (_args: NotificationDispatchRequest) => ({ delivered: true })),
      playSound: vi.fn(),
      openSystemSettings: vi.fn(),
      requestPermission: vi.fn()
    }
    vi.stubGlobal('window', {
      Notification: { permission: 'denied' },
      api: {
        notifications,
        shell: { pickAudio: vi.fn() }
      }
    })

    await sendNotificationSettingsTestNotification(createSettings().notifications, 50)

    // Probe main-process Electron delivery; renderer permission state can remain stale after macOS settings change.
    expect(notifications.dispatch).toHaveBeenCalledWith({
      source: 'test',
      requireDisplayConfirmation: true
    })
    expect(toastError).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastMessage).toHaveBeenCalledWith(
      'Test notification requested',
      expect.objectContaining({
        description: 'If no macOS banner appeared, enable Allow notifications for Orca.',
        action: expect.objectContaining({ label: 'Open Settings' })
      })
    )

    const toastOptions = toastMessage.mock.calls[0]?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined
    toastOptions?.action?.onClick?.()
    expect(notifications.openSystemSettings).toHaveBeenCalledTimes(1)
  })
})
