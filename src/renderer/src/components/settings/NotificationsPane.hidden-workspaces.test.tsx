// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { NotificationsPane } from './NotificationsPane'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() } }))

// Why a non-macOS answer: the permission card would otherwise probe delivery on mount.
beforeEach(() => {
  vi.stubGlobal('api', {
    notifications: {
      getPermissionStatus: vi.fn(async () => ({
        supported: false,
        platform: 'linux',
        requested: false
      }))
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const LABEL = 'Notify About Hidden Workspaces'

function renderPane(enabled = true) {
  const defaults = getDefaultSettings('/tmp')
  const updateSettings = vi.fn()
  const view = render(
    <NotificationsPane
      settings={{ ...defaults, notifications: { ...defaults.notifications, enabled } }}
      updateSettings={updateSettings}
    />
  )
  return { updateSettings, toggle: view.getByRole('switch', { name: LABEL }), view }
}

describe('NotificationsPane hidden workspaces row', () => {
  it('renders, defaults off, and turns the setting on', () => {
    const { updateSettings, toggle, view } = renderPane()
    expect(view.getByText(LABEL)).toBeTruthy()
    expect(
      view.getByText(
        "When off, workspaces hidden by a Hide switch in the sidebar's Filters menu show no unread dot and send no notifications to this computer or your phone."
      )
    ).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)

    expect(updateSettings).toHaveBeenCalledWith({
      notifications: expect.objectContaining({ notifyHiddenWorkspaces: true })
    })
  })

  it('stays usable while notifications are disabled, since it also governs unread dots', () => {
    const { toggle } = renderPane(false)
    expect(toggle.hasAttribute('disabled')).toBe(false)
  })
})
