// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GiteaNotification } from '../../../../../shared/gitea-types'

const api = vi.hoisted(() => ({ markNotificationRead: vi.fn() }))

vi.mock('@/runtime/gitea-owner-api', () => ({ giteaApiFor: () => api }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { TaskPageGiteaNotificationList } from './NotificationList'

const notification: GiteaNotification = {
  id: 5,
  subjectType: 'Issue',
  subjectTitle: 'Fix it',
  subjectUrl: 'https://gitea.example/o/r/issues/1',
  subjectNumber: 1,
  repositoryPath: 'o/r',
  updatedAt: '2026-10-01T00:00:00Z',
  unread: true
}

function renderList(setGiteaNotifications = vi.fn()) {
  const model = {
    primaryRepo: { id: 'repo', path: '/work/app', displayName: 'app', badgeColor: '', addedAt: 1 },
    giteaNotifications: [notification],
    giteaNotificationsLoading: false,
    setGiteaNotifications
  }
  // SAFETY: the component only reads the fields provided above.
  render(<TaskPageGiteaNotificationList model={model as never} />)
  return setGiteaNotifications
}

beforeEach(() => api.markNotificationRead.mockReset().mockResolvedValue({ ok: true }))
afterEach(cleanup)

describe('TaskPageGiteaNotificationList', () => {
  it('marks a notification read and drops it from the feed', async () => {
    const setGiteaNotifications = renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }))

    await waitFor(() =>
      expect(api.markNotificationRead).toHaveBeenCalledWith(
        expect.objectContaining({ repoPath: '/work/app', notificationId: 5 })
      )
    )
    const update = setGiteaNotifications.mock.calls[0][0] as (
      list: GiteaNotification[]
    ) => GiteaNotification[]
    expect(update([notification])).toEqual([])
  })

  it('restores the row when marking read fails', async () => {
    api.markNotificationRead.mockResolvedValue({ ok: false, error: 'nope' })
    const setGiteaNotifications = renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }))

    await waitFor(() => expect(setGiteaNotifications).toHaveBeenCalledTimes(2))
    const restore = setGiteaNotifications.mock.calls[1][0] as (
      list: GiteaNotification[]
    ) => GiteaNotification[]
    expect(restore([])).toEqual([notification])
  })
})
