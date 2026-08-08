import { describe, expect, it } from 'vitest'
import { formatSshTerminateSessionsNotice } from './ssh-terminate-sessions-result'

describe('formatSshTerminateSessionsNotice', () => {
  it('is silent when every remote session was reached', () => {
    expect(
      formatSshTerminateSessionsNotice({ remoteSessionsTerminated: 2, abandonedUnreachable: 0 })
    ).toBeNull()
  })

  it('warns when abandoned sessions could not be killed offline', () => {
    expect(
      formatSshTerminateSessionsNotice({ remoteSessionsTerminated: 0, abandonedUnreachable: 1 })
    ).toBe('1 abandoned remote session was not killed — reconnect to terminate it.')
    expect(
      formatSshTerminateSessionsNotice({ remoteSessionsTerminated: 0, abandonedUnreachable: 3 })
    ).toBe('3 abandoned remote sessions were not killed — reconnect to terminate them.')
  })
})
