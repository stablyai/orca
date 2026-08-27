// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  setPending: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: '',
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      setActiveView: vi.fn(),
      closeSettingsPage: vi.fn()
    })
}))

vi.mock('../shared/useDaemonActions', () => ({
  useDaemonActions: () => ({ isBusy: false, busyKind: null, setPending: mocks.setPending }),
  DaemonActionDialog: () => null
}))

vi.mock('./TerminalTccAttributionNotice', () => ({
  MANAGE_SESSIONS_SECTION_ID: 'manage-sessions',
  TerminalTccAttributionNotice: () => null
}))

vi.mock('./ManageSessionsTable', () => ({
  ManageSessionsTable: () => null
}))

vi.mock('./ManageSessionKillDialog', () => ({
  ManageSessionKillDialog: () => null
}))

vi.mock('../status-bar/daemon-session-inventory-invalidation', () => ({
  notifyDaemonSessionInventoryInvalidated: vi.fn()
}))

import { ManageSessionsSection } from './ManageSessionsSection'

describe('ManageSessionsSection terminate-on-quit toggle', () => {
  beforeEach(() => {
    mocks.listSessions.mockResolvedValue({ sessions: [] })
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: { pty: { management: { listSessions: mocks.listSessions } } }
      })
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('defaults off so quit keeps sessions warm for reattach', () => {
    render(<ManageSessionsSection settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    const toggle = screen.getByRole('switch', { name: 'Terminate sessions when quitting Orca' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('opts in and out through updateSettings', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    const { rerender } = render(
      <ManageSessionsSection
        settings={getDefaultSettings('/tmp')}
        updateSettings={updateSettings}
      />
    )

    await user.click(screen.getByRole('switch', { name: 'Terminate sessions when quitting Orca' }))
    expect(updateSettings).toHaveBeenCalledWith({ terminateSessionsOnQuit: true })

    rerender(
      <ManageSessionsSection
        settings={{ ...getDefaultSettings('/tmp'), terminateSessionsOnQuit: true }}
        updateSettings={updateSettings}
      />
    )
    const toggle = screen.getByRole('switch', { name: 'Terminate sessions when quitting Orca' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(updateSettings).toHaveBeenLastCalledWith({ terminateSessionsOnQuit: false })
  })
})
