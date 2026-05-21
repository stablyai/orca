import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, NotificationDispatchRequest } from '../../../../shared/types'
import { sendNotificationSettingsTestNotification } from './NotificationsPane'

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

function createSettings(): GlobalSettings {
  return {
    notifications: {
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: true,
      customSoundPath: null,
      customSoundVolume: 50
    }
  } as GlobalSettings
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

    // Why: this UI sends via Electron's main-process Notification module;
    // renderer Web Notification.permission can stay stale after macOS Settings changes.
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

  it('confirms delivered test notifications on platforms where show means displayed', async () => {
    const notifications = {
      getPermissionStatus: vi.fn(async () => ({
        supported: true,
        platform: 'win32' as NodeJS.Platform,
        requested: true
      })),
      dispatch: vi.fn(async (_args: NotificationDispatchRequest) => ({ delivered: true })),
      playSound: vi.fn(),
      openSystemSettings: vi.fn(),
      requestPermission: vi.fn()
    }
    vi.stubGlobal('window', {
      Notification: { permission: 'granted' },
      api: {
        notifications,
        shell: { pickAudio: vi.fn() }
      }
    })

    await sendNotificationSettingsTestNotification(createSettings().notifications, 50)

    expect(toastMessage).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Test notification sent')
  })

  it('opens macOS notification settings when the native test notification is not shown', async () => {
    const notifications = {
      getPermissionStatus: vi.fn(async () => ({
        supported: true,
        platform: 'darwin' as NodeJS.Platform,
        requested: true
      })),
      dispatch: vi.fn(async (_args: NotificationDispatchRequest) => ({
        delivered: false,
        reason: 'not-displayed' as const
      })),
      playSound: vi.fn(),
      openSystemSettings: vi.fn(),
      requestPermission: vi.fn()
    }
    vi.stubGlobal('window', {
      Notification: { permission: 'granted' },
      api: {
        notifications,
        shell: { pickAudio: vi.fn() }
      }
    })

    await sendNotificationSettingsTestNotification(createSettings().notifications, 50)

    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      'macOS did not show the notification',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Open Settings' })
      })
    )

    const toastOptions = toastError.mock.calls[0]?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined
    toastOptions?.action?.onClick?.()
    expect(notifications.openSystemSettings).toHaveBeenCalledTimes(1)
  })

  it('uses Windows notification settings copy when the native test notification is not shown', async () => {
    const notifications = {
      getPermissionStatus: vi.fn(async () => ({
        supported: true,
        platform: 'win32' as NodeJS.Platform,
        requested: true
      })),
      dispatch: vi.fn(async (_args: NotificationDispatchRequest) => ({
        delivered: false,
        reason: 'not-displayed' as const
      })),
      playSound: vi.fn(),
      openSystemSettings: vi.fn(),
      requestPermission: vi.fn()
    }
    vi.stubGlobal('window', {
      Notification: { permission: 'granted' },
      api: {
        notifications,
        shell: { pickAudio: vi.fn() }
      }
    })

    await sendNotificationSettingsTestNotification(createSettings().notifications, 50)

    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      'Windows did not show the notification',
      expect.objectContaining({
        description: 'Enable notifications for Orca in Windows Settings.',
        action: expect.objectContaining({ label: 'Open Settings' })
      })
    )
  })

  it('does not show an inert settings action on platforms without a settings shortcut', async () => {
    const notifications = {
      getPermissionStatus: vi.fn(async () => ({
        supported: true,
        platform: 'linux' as NodeJS.Platform,
        requested: true
      })),
      dispatch: vi.fn(async (_args: NotificationDispatchRequest) => ({
        delivered: false,
        reason: 'not-displayed' as const
      })),
      playSound: vi.fn(),
      openSystemSettings: vi.fn(),
      requestPermission: vi.fn()
    }
    vi.stubGlobal('window', {
      Notification: { permission: 'granted' },
      api: {
        notifications,
        shell: { pickAudio: vi.fn() }
      }
    })

    await sendNotificationSettingsTestNotification(createSettings().notifications, 50)

    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      'System did not show the notification',
      expect.not.objectContaining({
        action: expect.anything()
      })
    )
    expect(notifications.openSystemSettings).not.toHaveBeenCalled()
  })
})
