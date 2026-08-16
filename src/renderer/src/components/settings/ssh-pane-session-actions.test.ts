import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: { value0?: number }) =>
    fallback.replace('{{value0}}', String(values?.value0 ?? ''))
}))
vi.mock('sonner', () => ({ toast: {} }))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('./ssh-session-termination', () => ({ terminateSshSessionsWithReconnect: vi.fn() }))

import { formatSshTerminateSessionsNotice } from './ssh-pane-session-actions'

describe('formatSshTerminateSessionsNotice', () => {
  it('is silent when every remote session was reached', () => {
    expect(
      formatSshTerminateSessionsNotice({ remoteSessionsTerminated: 2, abandonedUnreachable: 0 })
    ).toBeNull()
  })

  it('formats localized singular and plural warnings', () => {
    expect(
      formatSshTerminateSessionsNotice({ remoteSessionsTerminated: 0, abandonedUnreachable: 1 })
    ).toBe('1 abandoned remote session was not killed — reconnect to terminate it.')
    expect(
      formatSshTerminateSessionsNotice({ remoteSessionsTerminated: 0, abandonedUnreachable: 3 })
    ).toBe('3 abandoned remote sessions were not killed — reconnect to terminate them.')
  })
})
