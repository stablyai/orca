// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { trackTelemetry, restart, openSettings, resetFolderAccess, dismissToast } = vi.hoisted(
  () => ({
    trackTelemetry: vi.fn(),
    restart: vi.fn(async () => ({ success: true })),
    openSettings: vi.fn(async () => {}),
    resetFolderAccess: vi.fn(),
    dismissToast: vi.fn()
  })
)

vi.mock('sonner', () => ({ toast: { dismiss: dismissToast } }))
vi.mock('@/lib/telemetry', () => ({ track: trackTelemetry }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => options?.[name] ?? match)
}))

import { MacFolderAccessFixDialog } from './MacFolderAccessFixDialog'
import {
  useMacFolderAccessFixStore,
  type FolderAccessNoticePhase
} from '@/store/mac-folder-access-fix'

const SCOPE = 'aaaa111122223333'

function noticePhase(): FolderAccessNoticePhase | undefined {
  return useMacFolderAccessFixStore.getState().noticePhaseByScope.get(SCOPE)
}

function verdict(
  freshDaemonAccess: 'allowed' | 'denied' | 'unknown',
  daemonScope: string = SCOPE
): void {
  act(() => {
    useMacFolderAccessFixStore
      .getState()
      .applyVerdict({ daemonScope, cwdClass: 'documents', freshDaemonAccess })
  })
}

function openWith(
  freshDaemonAccess: 'allowed' | 'denied' | 'unknown',
  cwdClass: 'documents' | 'other-home' | 'outside-home' = 'documents'
): void {
  useMacFolderAccessFixStore.setState({
    mismatch: { daemonScope: SCOPE, cwdClass, freshDaemonAccess },
    openScope: SCOPE,
    noticePhaseByScope: new Map<string, FolderAccessNoticePhase>([[SCOPE, 'visible']])
  })
}

function dialogShown(): boolean {
  return screen.queryByRole('dialog') !== null
}

function restartButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Restart/ })
}

function resetButton(): HTMLElement {
  return screen.getByRole('button', { name: /^Reset/ })
}

/** The verdict a forced re-probe returned after the reset ran. */
function probed(freshDaemonAccess: 'allowed' | 'denied' | 'unknown'): void {
  resetFolderAccess.mockResolvedValue({
    outcome: 'probed',
    mismatch: { daemonScope: 'aaaa111122223333', cwdClass: 'documents', freshDaemonAccess }
  })
}

function footerButton(name: string): HTMLElement {
  const footer = screen.getByRole('dialog').querySelector('[data-slot="dialog-footer"]')
  if (!(footer instanceof HTMLElement)) {
    throw new Error('dialog footer did not render')
  }
  return within(footer).getByRole('button', { name })
}

beforeEach(() => {
  trackTelemetry.mockReset()
  restart.mockReset().mockResolvedValue({ success: true })
  openSettings.mockReset().mockResolvedValue(undefined)
  resetFolderAccess.mockReset()
  dismissToast.mockReset()
  probed('denied')
  useMacFolderAccessFixStore.setState({
    mismatch: null,
    openScope: null,
    noticePhaseByScope: new Map<string, FolderAccessNoticePhase>()
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { management: { restart, resetFolderAccess } },
      developerPermissions: { openSettings }
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('MacFolderAccessFixDialog', () => {
  it('renders nothing until the toast raises it', () => {
    render(<MacFolderAccessFixDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the denied folder and leads with the cause', () => {
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    expect(screen.getByText('Fix access to your Documents folder')).toBeTruthy()
    expect(
      screen.getByText('macOS is blocking Orca’s terminal service from this folder.')
    ).toBeTruthy()
    expect(screen.getByText('Open terminals and agents will restart.')).toBeTruthy()
  })

  // 'allowed' means a daemon forked now could already read the folder.
  it('hides step one and enables Restart when the grant is already in place', () => {
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    expect(restartButton().hasAttribute('disabled')).toBe(false)
  })

  it('offers only the reset when a fresh daemon is still denied, and says what it does', () => {
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    expect(footerButton('Cancel')).toBeTruthy()
    expect(footerButton('Reset permission')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull()
    expect(screen.getByText('Re-allow Orca for your Documents folder')).toBeTruthy()
    expect(screen.getByText(/Reset asks macOS for the permission again/)).toBeTruthy()
  })

  // Only Documents, Desktop and Downloads have a TCC row, so a reset elsewhere is a button that
  // cannot work. A workspace symlinked out of Documents, or one on an external volume, lands here.
  it.each([['other-home'], ['outside-home']] as const)(
    'points a denied %s workspace at System Settings instead of a reset',
    (cwdClass) => {
      openWith('denied', cwdClass)
      render(<MacFolderAccessFixDialog />)

      expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull()
      expect(footerButton('Cancel')).toBeTruthy()
      expect(footerButton('Open System Settings')).toBeTruthy()
    }
  )

  // Nothing here has been verified for a class with no row, so step one promises nothing.
  it('drops the reset explanation when there is no permission to reset', () => {
    openWith('denied', 'other-home')
    render(<MacFolderAccessFixDialog />)

    expect(screen.getByText('Allow Orca under Files and Folders')).toBeTruthy()
    expect(screen.queryByText(/Reset asks macOS for the permission again/)).toBeNull()
  })

  // An unanswered probe must not accuse the user of a missing grant, but the pane stays reachable.
  it('keeps both actions and says so when the probe could not answer', () => {
    openWith('unknown')
    render(<MacFolderAccessFixDialog />)

    expect(footerButton('Open System Settings')).toBeTruthy()
    expect(restartButton().hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Couldn’t verify. Skip if already allowed.')).toBeTruthy()
  })

  it('flips step one to done when a later poll reports the grant landed', async () => {
    openWith('denied')
    render(<MacFolderAccessFixDialog />)
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull()

    act(() => {
      useMacFolderAccessFixStore.getState().applyVerdict({
        daemonScope: 'aaaa111122223333',
        cwdClass: 'documents',
        freshDaemonAccess: 'allowed'
      })
    })

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    })
    expect(restartButton().hasAttribute('disabled')).toBe(false)
  })

  it('opens the Files and Folders pane through the permission opener', async () => {
    openWith('unknown')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))

    expect(openSettings).toHaveBeenCalledWith({ id: 'files-and-folders' })
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'settings_opened',
      cwd_class: 'documents'
    })
  })

  it('restarts the terminal service without a second confirmation', async () => {
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    expect(restart).toHaveBeenCalledTimes(1)
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'restart_clicked',
      cwd_class: 'documents'
    })
  })

  it('shows a busy state while the restart runs', async () => {
    let release: (value: { success: boolean }) => void = () => {}
    restart.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        release = resolve
      })
    )
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    expect(screen.getByRole('button', { name: /Restarting/ }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      release({ success: true })
    })
  })

  it('checks off both steps, offers Done, and hands the toast to the notice hook', async () => {
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    await waitFor(() => {
      expect(footerButton('Done')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull()
    expect(screen.getByRole('dialog').querySelectorAll('.text-status-success')).toHaveLength(2)
    // A ticked step must not still warn about what it was going to cost.
    expect(screen.queryByText('Open terminals and agents will restart.')).toBeNull()
    // The daemon that earned the notice is gone, so its toast goes without counting a dismissal.
    expect(noticePhase()).toBe('retired')
  })

  it('reports a refused restart inline and leaves the button usable', async () => {
    restart.mockResolvedValue({ success: false })
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    await waitFor(() => {
      expect(
        screen.getByText('Restart failed. Try again from Settings → Terminal → Manage Sessions.')
      ).toBeTruthy()
    })
    expect(restartButton().hasAttribute('disabled')).toBe(false)
    expect(noticePhase()).toBe('visible')
  })

  it('reports a rejected restart the same way', async () => {
    restart.mockRejectedValue(new Error('ipc gone'))
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(restartButton())

    await waitFor(() => {
      expect(
        screen.getByText('Restart failed. Try again from Settings → Terminal → Manage Sessions.')
      ).toBeTruthy()
    })
    expect(restartButton().hasAttribute('disabled')).toBe(false)
  })

  it('reports the reset click and flips to Restart once the re-probe allows it', async () => {
    probed('allowed')
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(restartButton()).toBeTruthy()
    })
    expect(resetFolderAccess).toHaveBeenCalledTimes(1)
    expect(trackTelemetry).toHaveBeenCalledWith('daemon_folder_access_notice', {
      action: 'reset_clicked',
      cwd_class: 'documents'
    })
    expect(screen.queryByText('Still blocked after the reset.')).toBeNull()
  })

  it('says so when the re-probe still reports a denial', async () => {
    probed('denied')
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(screen.getByText('Still blocked after the reset.')).toBeTruthy()
    })
    expect(footerButton('Reset permission').hasAttribute('disabled')).toBe(false)
    expect(footerButton('Open System Settings')).toBeTruthy()
  })

  // Evidence gone mid-reset means the daemon was replaced; nothing is left to fix here.
  it('closes when the reset finds the evidence gone', async () => {
    resetFolderAccess.mockResolvedValue({ outcome: 'probed', mismatch: null })
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(dialogShown()).toBe(false)
    })
    expect(useMacFolderAccessFixStore.getState().mismatch).toBeNull()
    // The toast outlives the dialog unless something retires it, and only the store can.
    expect(noticePhase()).toBe('retired')
    expect(dismissToast).toHaveBeenCalledWith('mac-daemon-folder-access-mismatch')
  })

  // The footer flips to the restart branch the moment the grant lands, which can happen while the
  // reset is still running. A button must report its own work, never the dialog's.
  it('never labels the restart button with the reset that is running', async () => {
    let release: (value: { outcome: string }) => void = () => {}
    resetFolderAccess.mockReturnValue(
      new Promise<{ outcome: string }>((resolve) => {
        release = resolve
      })
    )
    openWith('denied')
    render(<MacFolderAccessFixDialog />)
    await userEvent.click(resetButton())

    verdict('allowed')

    expect(restartButton().textContent).toBe('Restart')
    expect(restartButton().hasAttribute('disabled')).toBe(true)

    await act(async () => {
      release({ outcome: 'unsupported' })
    })
  })

  // An unanswered probe is not evidence the reset failed, so the dialog says what it knows.
  it('does not claim a block the re-probe never confirmed', async () => {
    probed('unknown')
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(screen.getByText('Couldn’t verify. Skip if already allowed.')).toBeTruthy()
    })
    expect(screen.queryByText('Still blocked after the reset.')).toBeNull()
  })

  // Reset failed, then the user granted it in System Settings: the failure is no longer true.
  it('drops the reset failure once the grant lands', async () => {
    const failure = 'Couldn’t reset the permission. Use System Settings instead.'
    resetFolderAccess.mockResolvedValue({ outcome: 'reset_failed' })
    openWith('denied')
    render(<MacFolderAccessFixDialog />)
    await userEvent.click(resetButton())
    await waitFor(() => {
      expect(screen.getByText(failure)).toBeTruthy()
    })

    verdict('allowed')

    expect(screen.queryByText(failure)).toBeNull()
    expect(screen.getByRole('dialog').querySelectorAll('.text-status-success')).toHaveLength(1)
  })

  // Closing is the end of the remedy, so the scope returning later must not pop the dialog again.
  it('does not reopen itself when the original scope comes back', () => {
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    verdict('denied', 'bbbb444455556666')
    verdict('denied')

    expect(useMacFolderAccessFixStore.getState().openScope).toBeNull()
    expect(dialogShown()).toBe(false)
  })

  // The remedy belongs to one folder on one daemon, so evidence that moves is a different remedy.
  it('closes itself when the evidence moves to another scope', async () => {
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    act(() => {
      useMacFolderAccessFixStore.getState().applyVerdict({
        daemonScope: 'bbbb444455556666',
        cwdClass: 'desktop',
        freshDaemonAccess: 'denied'
      })
    })

    expect(dialogShown()).toBe(false)
  })

  it('drops the unverified helper once the restart is done', async () => {
    openWith('unknown')
    render(<MacFolderAccessFixDialog />)
    expect(screen.getByText('Couldn’t verify. Skip if already allowed.')).toBeTruthy()

    await userEvent.click(restartButton())

    await waitFor(() => {
      expect(footerButton('Done')).toBeTruthy()
    })
    expect(screen.queryByText('Couldn’t verify. Skip if already allowed.')).toBeNull()
  })

  it.each([['reset_failed'], ['unsupported']])(
    'points at System Settings when the reset comes back %s',
    async (outcome) => {
      resetFolderAccess.mockResolvedValue({ outcome })
      openWith('denied')
      render(<MacFolderAccessFixDialog />)

      await userEvent.click(resetButton())

      await waitFor(() => {
        expect(
          screen.getByText('Couldn’t reset the permission. Use System Settings instead.')
        ).toBeTruthy()
      })
      expect(screen.queryByText('Still blocked after the reset.')).toBeNull()
      expect(footerButton('Open System Settings')).toBeTruthy()
    }
  )

  it('reports a rejected reset the same way', async () => {
    resetFolderAccess.mockRejectedValue(new Error('ipc gone'))
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    await waitFor(() => {
      expect(
        screen.getByText('Couldn’t reset the permission. Use System Settings instead.')
      ).toBeTruthy()
    })
  })

  it('blocks every way out while the reset runs', async () => {
    let release: (value: { outcome: string }) => void = () => {}
    resetFolderAccess.mockReturnValue(
      new Promise<{ outcome: string }>((resolve) => {
        release = resolve
      })
    )
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(resetButton())

    expect(screen.getByRole('button', { name: /Resetting/ }).hasAttribute('disabled')).toBe(true)
    expect(footerButton('Cancel').hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(dialogShown()).toBe(true)

    await act(async () => {
      release({ outcome: 'unsupported' })
    })
  })

  // With no evidence there is nothing open, so a scope that comes back opens a fresh remedy.
  it('forgets what was open once the evidence is gone', () => {
    openWith('denied')
    render(<MacFolderAccessFixDialog />)

    act(() => {
      useMacFolderAccessFixStore.getState().applyVerdict(null)
    })

    expect(dialogShown()).toBe(false)
    expect(useMacFolderAccessFixStore.getState().openScope).toBeNull()
  })

  it('starts a replacement daemon’s remedy from scratch', async () => {
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)
    await userEvent.click(restartButton())
    await waitFor(() => {
      expect(footerButton('Done')).toBeTruthy()
    })
    await userEvent.click(footerButton('Done'))

    act(() => {
      useMacFolderAccessFixStore.getState().applyVerdict({
        daemonScope: 'bbbb444455556666',
        cwdClass: 'documents',
        freshDaemonAccess: 'denied'
      })
      useMacFolderAccessFixStore.getState().openFix()
    })

    expect(screen.getByRole('dialog').querySelectorAll('.text-status-success')).toHaveLength(0)
    expect(footerButton('Reset permission')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  // Closing unmounts the remedy, so no phase of it can be waiting when the same scope reopens.
  it('reopens the same scope with an unticked checklist', async () => {
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)
    await userEvent.click(restartButton())
    await waitFor(() => {
      expect(footerButton('Done')).toBeTruthy()
    })
    await userEvent.click(footerButton('Done'))

    act(() => {
      useMacFolderAccessFixStore.getState().openFix()
    })

    // One tick, from the verdict's own step; two would mean the finished restart outlived its close.
    expect(screen.getByRole('dialog').querySelectorAll('.text-status-success')).toHaveLength(1)
    expect(restartButton()).toBeTruthy()
  })

  it('closes on Cancel', async () => {
    openWith('allowed')
    render(<MacFolderAccessFixDialog />)

    await userEvent.click(footerButton('Cancel'))

    expect(dialogShown()).toBe(false)
  })
})
