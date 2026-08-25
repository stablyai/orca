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
      localExecution
    )

    expect(warningToastMock).toHaveBeenCalledWith(
      'None of the 3 cookies could be loaded, and the restart fallback was unavailable. The previous cookies for this profile were replaced. Try the import again.'
    )
    expect(successToastMock).not.toHaveBeenCalled()
  })

  it('shows success when the import has no warning', () => {
    emitBrowserCookieImportToast(summary, 'Imported 3 cookies.', localExecution)

    expect(successToastMock).toHaveBeenCalledWith('Imported 3 cookies.')
    expect(warningToastMock).not.toHaveBeenCalled()
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

  // Why: a client-hosted import stores cookies on this desktop for the named workspace; the
  // guidance must not read as "go sign in on the other machine".
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

  // Why (STA-4300): these cookies were skipped rather than written unpartitioned, so the success
  // count alone would report a lossy import as clean.
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

  it('does not infer a partition warning from generic skipped cookies', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1 },
      'Imported 2 cookies.',
      localExecution
    )

    expect(warningToastMock).not.toHaveBeenCalled()
  })

  it('does not infer a Google warning from generic skipped cookies', () => {
    emitBrowserCookieImportToast(
      { ...summary, importedCookies: 2, skippedCookies: 1 },
      'Imported 2 cookies.',
      localExecution
    )

    expect(successToastMock).toHaveBeenCalledWith('Imported 2 cookies.')
    expect(warningToastMock).not.toHaveBeenCalled()
  })

  // Why: the summary crosses the runtime RPC wire and is cast, not decoded, so a newer host can
  // publish a reason/code this client build has never heard of (#14683 follow-up).
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

  // Why: hasOwn coerces its key, so a host that widened `reason` to an array sends ['unknown'],
  // which a hasOwn-only guard admits before the switch drops it back out.
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
      remoteExecution
    )

    expect(successToastMock).not.toHaveBeenCalled()
    expect(warningToastMock.mock.calls).toEqual([
      [
        'Imported 1 of 2 cookies. The rest could not be loaded, and the restart fallback was unavailable. Try the import again.'
      ],
      [
        'Google cookies were not imported. Open a browser tab in the Remote Mac workspace with this profile, then sign into Google.',
        { duration: 12000 }
      ]
    ])
  })
})
