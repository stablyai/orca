import { beforeEach, describe, expect, it, vi } from 'vitest'

const { successToastMock, warningToastMock, errorToastMock, getStateMock } = vi.hoisted(() => ({
  successToastMock: vi.fn(),
  warningToastMock: vi.fn(),
  errorToastMock: vi.fn(),
  getStateMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: successToastMock, warning: warningToastMock, error: errorToastMock }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

import type { BrowserCookieImportSummary } from '../../../shared/types'
import { emitBrowserCookieImportToast } from './browser-cookie-import-toast'

const summary: BrowserCookieImportSummary = {
  totalCookies: 3,
  importedCookies: 3,
  skippedCookies: 0,
  domains: ['example.com']
}

describe('emitBrowserCookieImportToast', () => {
  beforeEach(() => {
    successToastMock.mockReset()
    warningToastMock.mockReset()
    errorToastMock.mockReset()
    getStateMock.mockReset()
    getStateMock.mockReturnValue({
      activeWorktreeId: 'worktree-1',
      closeSettingsPage: vi.fn(),
      openBrowserProfileTabInActiveWorkspace: vi.fn().mockResolvedValue(true)
    })
  })

  it('shows the localized total-failure warning', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'restart-fallback-unavailable',
          loadedCookies: 0,
          failedCookies: 3
        }
      },
      'Imported 3 cookies.',
      'profile-1'
    )

    expect(warningToastMock).toHaveBeenCalledWith(
      'None of the 3 cookies could be loaded, and the restart fallback was unavailable. The previous cookies for this profile were replaced. Try the import again.'
    )
    expect(successToastMock).not.toHaveBeenCalled()
  })

  it('shows the localized partial-failure warning', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'restart-fallback-unavailable',
          loadedCookies: 2,
          failedCookies: 1
        }
      },
      'Imported 3 cookies.',
      'profile-1'
    )

    expect(warningToastMock).toHaveBeenCalledWith(
      'Imported 2 of 3 cookies. The rest could not be loaded, and the restart fallback was unavailable. Try the import again.'
    )
    expect(successToastMock).not.toHaveBeenCalled()
  })

  it('shows success when the import has no warning', () => {
    emitBrowserCookieImportToast(summary, 'Imported 3 cookies.', 'profile-1')

    expect(successToastMock).toHaveBeenCalledWith('Imported 3 cookies.')
    expect(warningToastMock).not.toHaveBeenCalled()
  })

  it('shows a separate Google sign-in warning after the concise success toast', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      'profile-1'
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.')
    expect(warningToastMock.mock.calls[0][0]).toBe(
      'Google cookies were not imported. Open a browser in Orca with this profile, then sign into Google.'
    )
    expect(warningToastMock.mock.calls[0][1].action.label).toBe('Sign in to Google')
    expect(successToastMock.mock.invocationCallOrder[0]).toBeLessThan(
      warningToastMock.mock.invocationCallOrder[0]
    )
  })

  it('does not infer a Google warning from generic skipped cookies', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1 },
      'Imported 2 cookies.',
      'profile-1'
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.')
    expect(warningToastMock).not.toHaveBeenCalled()
  })

  it('keeps both applicable warnings when restart fallback is unavailable', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        importedCookies: 1,
        skippedCookies: 2,
        googleCookiesSkipped: 1,
        warning: {
          code: 'restart-fallback-unavailable',
          loadedCookies: 1,
          failedCookies: 1
        }
      },
      'Imported 1 cookie.',
      'profile-1'
    )

    expect(successToastMock).not.toHaveBeenCalled()
    expect(warningToastMock.mock.calls.map(([message]) => message)).toEqual([
      'Imported 1 of 2 cookies. The rest could not be loaded, and the restart fallback was unavailable. Try the import again.',
      'Google cookies were not imported. Open a browser in Orca with this profile, then sign into Google.'
    ])
  })

  it('opens Google with the imported profile from the warning action', async () => {
    const closeSettingsPage = vi.fn()
    const openBrowserProfileTabInActiveWorkspace = vi.fn().mockResolvedValue(true)
    getStateMock.mockReturnValue({
      activeWorktreeId: 'worktree-1',
      closeSettingsPage,
      openBrowserProfileTabInActiveWorkspace
    })

    emitBrowserCookieImportToast(
      { ...summary, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      'profile-1'
    )
    warningToastMock.mock.calls[0][1].action.onClick()

    await vi.waitFor(() => expect(closeSettingsPage).toHaveBeenCalledTimes(1))
    expect(openBrowserProfileTabInActiveWorkspace).toHaveBeenCalledWith(
      'https://accounts.google.com/',
      'profile-1'
    )
  })

  it('keeps guidance but omits the action without an active worktree', () => {
    getStateMock.mockReturnValue({ activeWorktreeId: null })

    emitBrowserCookieImportToast(
      { ...summary, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      'profile-1'
    )

    expect(warningToastMock).toHaveBeenLastCalledWith(
      'Google cookies were not imported. Open a browser in Orca with this profile, then sign into Google.'
    )
  })

  it('reports when the profile tab cannot be opened', async () => {
    const openBrowserProfileTabInActiveWorkspace = vi.fn().mockResolvedValue(false)
    getStateMock.mockReturnValue({
      activeWorktreeId: 'worktree-1',
      closeSettingsPage: vi.fn(),
      openBrowserProfileTabInActiveWorkspace
    })

    emitBrowserCookieImportToast(
      { ...summary, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      'profile-1'
    )
    warningToastMock.mock.calls[0][1].action.onClick()

    await vi.waitFor(() => expect(errorToastMock).toHaveBeenCalledTimes(1))
    expect(errorToastMock).toHaveBeenCalledWith(
      'Could not open the browser profile. Open it and sign in at accounts.google.com.'
    )
  })

  it('reports when opening the profile tab rejects', async () => {
    getStateMock.mockReturnValue({
      activeWorktreeId: 'worktree-1',
      closeSettingsPage: vi.fn(),
      openBrowserProfileTabInActiveWorkspace: vi
        .fn()
        .mockRejectedValue(new Error('runtime unavailable'))
    })

    emitBrowserCookieImportToast(
      { ...summary, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      'profile-1'
    )
    warningToastMock.mock.calls[0][1].action.onClick()

    await vi.waitFor(() => expect(errorToastMock).toHaveBeenCalledTimes(1))
  })
})
