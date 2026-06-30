// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  GlobalSettings,
  NotificationDispatchRequest,
  NotificationInboxResult
} from '../../../../shared/types'
import { getNotificationSoundOptions } from '@/components/notification-sound-options'
import {
  createNotificationVolumeDraftState,
  NotificationsPane,
  resolveNotificationVolumeDraftState,
  sendNotificationSettingsTestNotification
} from './NotificationsPane'

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
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 50
    }
  } as GlobalSettings
}

function createNotificationsApi(inbox: NotificationInboxResult) {
  return {
    getPermissionStatus: vi.fn(async () => ({
      supported: true,
      platform: 'darwin' as NodeJS.Platform,
      requested: true
    })),
    dispatch: vi.fn(async (_args: NotificationDispatchRequest) => ({ delivered: true })),
    playSound: vi.fn(),
    openSystemSettings: vi.fn(),
    requestPermission: vi.fn(),
    getInbox: vi.fn(async () => inbox),
    markInboxRead: vi.fn(async () => ({
      ...inbox,
      unreadCount: 0,
      entries: inbox.entries.map((entry) => ({ ...entry, unread: false }))
    })),
    clearInbox: vi.fn(async () => ({ supported: inbox.supported, entries: [], unreadCount: 0 }))
  }
}

function stubNotificationsApi(notifications = createNotificationsApi(createEmptyInbox())) {
  vi.stubGlobal('Notification', { permission: 'granted' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      notifications,
      shell: { pickAudio: vi.fn() }
    }
  })
  return notifications
}

function createEmptyInbox(): NotificationInboxResult {
  return {
    supported: true,
    entries: [],
    unreadCount: 0
  }
}

function createInbox(): NotificationInboxResult {
  return {
    supported: true,
    unreadCount: 3,
    entries: [
      {
        id: 'agent:one',
        notificationId: 'agent:one',
        source: 'agent-task-complete',
        title: 'feat/notis - Codex finished',
        body: 'Updated the notification inbox.',
        createdAt: Date.parse('2026-03-28T16:00:00Z'),
        unread: true,
        worktreeId: 'repo::wt1',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        repoLabel: 'orca',
        worktreeLabel: 'feat/notis'
      }
    ]
  }
}

describe('NotificationsPane', () => {
  beforeEach(() => {
    toastError.mockClear()
    toastMessage.mockClear()
    toastSuccess.mockClear()
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined
    })
    vi.unstubAllGlobals()
  })

  it('renders built-in notification sound choices in settings', () => {
    const html = renderToStaticMarkup(
      <NotificationsPane settings={createSettings()} updateSettings={vi.fn()} />
    )

    expect(html).toContain('Notification Sound')
    expect(getNotificationSoundOptions(null).map((option) => option.title)).toEqual(
      expect.arrayContaining(['System Default', 'Two Tone', 'Bong', 'Ding'])
    )
  })

  it('loads and renders the empty notification inbox state', async () => {
    const notifications = stubNotificationsApi()

    render(<NotificationsPane settings={createSettings()} updateSettings={vi.fn()} />)

    expect(await screen.findByText('Notification Inbox')).toBeInTheDocument()
    expect(await screen.findByText('No recent notifications')).toBeInTheDocument()
    expect(screen.getByText('No unread notifications')).toBeInTheDocument()
    expect(notifications.getInbox).toHaveBeenCalledTimes(1)
  })

  it('renders owner-provided inbox entries and unread count', async () => {
    stubNotificationsApi(createNotificationsApi(createInbox()))

    render(<NotificationsPane settings={createSettings()} updateSettings={vi.fn()} />)

    expect(await screen.findByText('feat/notis - Codex finished')).toBeInTheDocument()
    expect(screen.getByText('Updated the notification inbox.')).toBeInTheDocument()
    expect(screen.getByText('3 unread')).toBeInTheDocument()
    expect(screen.getByText('Unread')).toBeInTheDocument()
    expect(screen.getByText(/Agent task - orca \/ feat\/notis -/)).toBeInTheDocument()
  })

  it('marks the owner-backed inbox read and updates visible unread state', async () => {
    const notifications = stubNotificationsApi(createNotificationsApi(createInbox()))
    const user = userEvent.setup()

    render(<NotificationsPane settings={createSettings()} updateSettings={vi.fn()} />)

    expect(await screen.findByText('3 unread')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /mark read/i }))

    await waitFor(() => expect(notifications.markInboxRead).toHaveBeenCalledTimes(1))
    expect(screen.getByText('No unread notifications')).toBeInTheDocument()
    expect(screen.queryByText('Unread')).not.toBeInTheDocument()
  })

  it('clears the owner-backed inbox and renders the empty state', async () => {
    const notifications = stubNotificationsApi(createNotificationsApi(createInbox()))
    const user = userEvent.setup()

    render(<NotificationsPane settings={createSettings()} updateSettings={vi.fn()} />)

    expect(await screen.findByText('feat/notis - Codex finished')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /clear/i }))

    await waitFor(() => expect(notifications.clearInbox).toHaveBeenCalledTimes(1))
    expect(screen.getByText('No recent notifications')).toBeInTheDocument()
  })

  it('resets the volume draft only when the persisted volume changes', () => {
    const state = createNotificationVolumeDraftState(50)
    state.draft = 75

    expect(resolveNotificationVolumeDraftState(state, 50)).toBe(state)
    expect(resolveNotificationVolumeDraftState(state, 25)).toEqual({
      sourceVolume: 25,
      draft: 25
    })
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
