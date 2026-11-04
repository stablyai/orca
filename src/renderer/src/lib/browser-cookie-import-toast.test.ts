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
