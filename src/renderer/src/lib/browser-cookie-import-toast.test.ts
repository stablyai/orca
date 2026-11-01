import { beforeEach, describe, expect, it, vi } from 'vitest'

const { successToastMock, warningToastMock } = vi.hoisted(() => ({
  successToastMock: vi.fn(),
  warningToastMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: successToastMock, warning: warningToastMock }
}))

import type { BrowserCookieImportSummary } from '../../../shared/browser-workspace-types'
import { emitBrowserCookieImportToast } from './browser-cookie-import-toast'

const summary: BrowserCookieImportSummary = {
  totalCookies: 3,
  importedCookies: 3,
  skippedCookies: 0,
  domains: ['example.com']
}

const localExecution = {
  executionHostLabel: 'Local Mac',
  executionMachine: 'client' as const,
  executionRemoteEnvironment: false
}

const clientHostedExecution = {
  executionHostLabel: 'm4 air',
  executionMachine: 'client' as const,
  executionRemoteEnvironment: true
}

const remoteExecution = {
  executionHostLabel: 'Remote Mac',
  executionMachine: 'remote' as const,
  executionRemoteEnvironment: true
}

describe('emitBrowserCookieImportToast', () => {
  beforeEach(() => {
    successToastMock.mockReset()
    warningToastMock.mockReset()
  })

  it('shows success when the import has no warning', () => {
    emitBrowserCookieImportToast(summary, 'Imported 3 cookies.', localExecution)

    expect(successToastMock).toHaveBeenCalledWith('Imported 3 cookies.')
    expect(warningToastMock).not.toHaveBeenCalled()
  })

  it.each([2, 0])('reports %i imported and 2 ordinary skipped cookies once', (importedCookies) => {
    emitBrowserCookieImportToast(
      { ...summary, totalCookies: importedCookies + 2, importedCookies, skippedCookies: 2 },
      `Imported ${importedCookies} cookies.`,
      localExecution
    )

    expect(successToastMock).toHaveBeenCalledExactlyOnceWith(
      `Imported ${importedCookies} cookies. 2 cookies skipped.`
    )
    expect(warningToastMock).not.toHaveBeenCalled()
  })

  it('counts only skips not already explained by Google and partition warnings', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        totalCookies: 6,
        importedCookies: 2,
        skippedCookies: 4,
        googleCookiesSkipped: 1,
        partitionSkippedCookies: 1
      },
      'Imported 2 cookies.',
      remoteExecution
    )

    expect(successToastMock).toHaveBeenCalledExactlyOnceWith(
      'Imported 2 cookies. 2 cookies skipped.',
      { description: 'Read from browsers on Remote Mac and stored there.' }
    )
    expect(warningToastMock).toHaveBeenCalledTimes(2)
    expect(warningToastMock.mock.calls[1]?.[0]).toContain(
      '1 cookies were not imported because their site-partition could not be read.'
    )
  })

  it('relies on the existing undecryptable warning without duplicating failure counts', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        totalCookies: 6,
        importedCookies: 2,
        skippedCookies: 4,
        warning: { code: 'cookies-undecryptable', failedCookies: 2, reason: 'unknown' }
      },
      'Imported 2 cookies.',
      localExecution
    )

    expect(warningToastMock).toHaveBeenCalledExactlyOnceWith(
      '2 cookies could not be decrypted and were skipped. Close the source browser completely and try the import again.'
    )
    expect(successToastMock).not.toHaveBeenCalled()
  })

  it('offers the in-app file import without recommending an exporter', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'cookies-undecryptable',
          failedCookies: 3,
          reason: 'app-bound-encryption'
        }
      },
      'Imported 0 cookies.',
      localExecution
    )

    const message = warningToastMock.mock.calls[0]?.[0]
    expect(message).toBe(
      "Orca cannot decrypt 3 of this browser's cookies because they use app-bound encryption. You can import cookies from a file using “From File…”."
    )
    expect(message).not.toContain('export')
  })

  it('names the missing Linux cookie-key tool and source browser', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'cookies-undecryptable',
          failedCookies: 3,
          reason: 'linux-keyring-unavailable',
          otherFailedCookies: 1,
          keyringFailure: { cause: 'secret-tool-missing', browser: 'Google Chrome' }
        }
      },
      'Imported 0 cookies.',
      localExecution
    )

    const message = warningToastMock.mock.calls[0]?.[0]
    expect(message).toContain('Google Chrome')
    expect(message).toContain('secret-tool')
    expect(message).toContain('libsecret-tools')
    expect(message).toContain('import again')
    expect(message).toContain('1 more cookies could not be decrypted for another reason.')
    expect(message).not.toMatch(/keyring|gnome-keyring/i)
  })

  it.each([
    { cause: 'keyring-locked' as const, action: 'Unlock your login keyring' },
    { cause: 'key-unavailable' as const, action: 'sign in directly in Orca' }
  ])('gives the recovery action for $cause', ({ cause, action }) => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'cookies-undecryptable',
          failedCookies: 3,
          reason: 'linux-keyring-unavailable',
          keyringFailure: { cause, browser: 'Google Chrome' }
        }
      },
      'Imported 0 cookies.',
      localExecution
    )

    const message = warningToastMock.mock.calls[0]?.[0]
    expect(message).toContain('Google Chrome')
    expect(message).toContain(action)
    expect(message).not.toContain('libsecret-tools')
  })

  it.each([
    { detail: 'absent detail', keyringFailure: undefined },
    { detail: 'absent cause', keyringFailure: { browser: 'Google Chrome' } },
    {
      detail: 'unknown cause',
      keyringFailure: { cause: 'future-key-source', browser: 'Google Chrome' }
    }
  ])('keeps the legacy keyring warning for $detail', ({ keyringFailure }) => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        importedCookies: 0,
        totalCookies: 5,
        skippedCookies: 5,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulate missing/future nested cause values from an unvalidated RPC peer.
        warning: {
          code: 'cookies-undecryptable',
          failedCookies: 3,
          reason: 'linux-keyring-unavailable',
          otherFailedCookies: 2,
          keyringFailure
        } as unknown as BrowserCookieImportSummary['warning']
      },
      'Imported 0 cookies.',
      remoteExecution
    )

    expect(warningToastMock).toHaveBeenCalledTimes(1)
    expect(warningToastMock).toHaveBeenCalledWith(
      '3 cookies could not be decrypted because the system keyring was unavailable; 2 more could not be decrypted for another reason. Unlock your login keyring (or install a Secret Service provider such as gnome-keyring) and import again.'
    )
    expect(successToastMock).not.toHaveBeenCalled()
  })

  it('shows workspace-specific Google guidance after a remote-side import', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      remoteExecution
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.', {
      description: 'Read from browsers on Remote Mac and stored there.'
    })
    expect(warningToastMock).toHaveBeenCalledWith(
      'Google cookies were not imported. Open a browser tab in the Remote Mac workspace with this profile, then sign into Google.',
      { duration: 12000 }
    )
    expect(successToastMock.mock.invocationCallOrder[0]).toBeLessThan(
      warningToastMock.mock.invocationCallOrder[0]
    )
  })

  // Client-hosted imports populate this desktop’s workspace jar; guidance must not send users to another machine.
  it('says the workspace tab opens on this device for a client-hosted import', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      clientHostedExecution
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.', {
      description: 'Read from this device and stored here for the m4 air workspace.'
    })
    expect(warningToastMock).toHaveBeenCalledWith(
      'Google cookies were not imported. Open a browser tab in the m4 air workspace with this profile — it opens on this device — then sign into Google.',
      { duration: 12000 }
    )
  })

  it('names no machine in the Google guidance for a purely local import', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1, googleCookiesSkipped: 1 },
      'Imported 2 cookies.',
      localExecution
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.')
    expect(warningToastMock).toHaveBeenCalledWith(
      'Google cookies were not imported. Open a browser in Orca with this profile, then sign into Google.',
      { duration: 12000 }
    )
  })

  // Skipped partitioned cookies make import lossy; success counts alone hide it (STA-4300).
  it('warns separately about cookies skipped for an unreadable partition', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1, partitionSkippedCookies: 1 },
      'Imported 2 cookies.',
      localExecution
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.')
    expect(warningToastMock).toHaveBeenCalledWith(
      '1 cookies were not imported because their site-partition could not be read. Sign in to those sites again in Orca.',
      { duration: 12000 }
    )
  })

  it('distinguishes unreadable cookies from readable cookies withheld to protect sessions', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        importedCookies: 1,
        skippedCookies: 2,
        partitionSkippedCookies: 2,
        partitionSkipBreakdown: { unreadableCookies: 1, preservedRelatedCookies: 1 }
      },
      'Imported 1 cookie.',
      remoteExecution
    )
    expect(warningToastMock).toHaveBeenCalledWith(
      'Cookies with unreadable site partitions: 1. Related cookies also skipped: 1. Check these sites in this profile before signing in again.',
      { duration: 12000 }
    )
  })

  it('reports a skipped partition beside successfully imported readable siblings without claiming preservation', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        importedCookies: 2,
        skippedCookies: 1,
        partitionSkippedCookies: 1,
        partitionSkipBreakdown: { unreadableCookies: 1, preservedRelatedCookies: 0 }
      },
      'Imported 2 cookies.',
      localExecution
    )
    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.')
    expect(warningToastMock).toHaveBeenCalledWith(
      'Cookies with unreadable site partitions: 1. Related cookies also skipped: 0. Check these sites in this profile before signing in again.',
      { duration: 12000 }
    )
  })

  it('localizes the count breakdown without changing either count', async () => {
    const { i18n } = await import('@/i18n/i18n')
    const originalLanguage = i18n.language
    try {
      await i18n.changeLanguage('ja')
      emitBrowserCookieImportToast(
        {
          ...summary,
          totalCookies: 5,
          importedCookies: 1,
          skippedCookies: 4,
          partitionSkippedCookies: 2,
          partitionSkipBreakdown: { unreadableCookies: 1, preservedRelatedCookies: 1 }
        },
        'Imported 1 cookie.',
        localExecution
      )
      expect(successToastMock).toHaveBeenCalledExactlyOnceWith(
        'Imported 1 cookie. 2 件の Cookie をスキップしました。'
      )
      expect(warningToastMock.mock.calls[0]?.[0]).toContain('読み取れない Cookie: 1')
      expect(warningToastMock.mock.calls[0]?.[0]).toContain('スキップされた関連 Cookie: 1')
    } finally {
      await i18n.changeLanguage(originalLanguage)
    }
  })

  it.each([
    { unreadableCookies: 1, preservedRelatedCookies: 2 },
    { unreadableCookies: -1, preservedRelatedCookies: 3 },
    { unreadableCookies: 1.5, preservedRelatedCookies: 0.5 },
    { unreadableCookies: 0, preservedRelatedCookies: 2 },
    { unreadableCookies: Number.NaN, preservedRelatedCookies: 1 },
    { unreadableCookies: 1, preservedRelatedCookies: Number.POSITIVE_INFINITY },
    { unreadableCookies: Number.MAX_SAFE_INTEGER + 1, preservedRelatedCookies: 0 }
  ])('uses the existing warning for invalid breakdown counts: %j', (partitionSkipBreakdown) => {
    emitBrowserCookieImportToast(
      { ...summary, partitionSkippedCookies: 2, partitionSkipBreakdown },
      'Imported 1 cookie.',
      remoteExecution
    )
    expect(warningToastMock).toHaveBeenCalledWith(
      '2 cookies were not imported because their site-partition could not be read. Sign in to those sites again in Orca.',
      { duration: 12000 }
    )
  })

  it('does not infer a Google warning from generic skipped cookies', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1 },
      'Imported 2 cookies.',
      localExecution
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies. 1 cookies skipped.')
    expect(warningToastMock).not.toHaveBeenCalled()
  })

  // RPC summaries are cast rather than decoded; newer hosts can send unknown reason/code values (#14683).
  it('still warns when a newer host sends an undeclared undecryptable reason', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'cookies-undecryptable',
          failedCookies: 3,
          reason: 'hardware-token-required'
        } as unknown as BrowserCookieImportSummary['warning']
      },
      'Imported 0 cookies.',
      remoteExecution
    )

    const message = warningToastMock.mock.calls[0]?.[0]
    expect(typeof message).toBe('string')
    expect(message).not.toBe('')
    expect(message).toContain('3')
  })

  it('still warns when a newer host sends an undeclared warning code', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'profile-locked',
          failedCookies: 3
        } as unknown as BrowserCookieImportSummary['warning']
      },
      'Imported 0 cookies.',
      remoteExecution
    )

    const message = warningToastMock.mock.calls[0]?.[0]
    expect(typeof message).toBe('string')
    expect(message).not.toBe('')
  })

  // hasOwn coerces arrays to keys; reject [unknown] before it reaches the switch.
  it('still warns when a newer host sends the reason as an array', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: 'cookies-undecryptable',
          failedCookies: 3,
          reason: ['unknown']
        } as unknown as BrowserCookieImportSummary['warning']
      },
      'Imported 0 cookies.',
      remoteExecution
    )

    const message = warningToastMock.mock.calls[0]?.[0]
    expect(typeof message).toBe('string')
    expect(message).not.toBe('')
  })

  it('still warns when a newer host sends the warning code as an array', () => {
    emitBrowserCookieImportToast(
      {
        ...summary,
        warning: {
          code: ['cookies-undecryptable'],
          failedCookies: 3,
          reason: 'unknown'
        } as unknown as BrowserCookieImportSummary['warning']
      },
      'Imported 0 cookies.',
      remoteExecution
    )

    const message = warningToastMock.mock.calls[0]?.[0]
    expect(typeof message).toBe('string')
    expect(message).not.toBe('')
  })
})
