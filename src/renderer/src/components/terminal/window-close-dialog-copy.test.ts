import { describe, expect, it } from 'vitest'
import { describeWindowCloseRunningWork } from './window-close-dialog-copy'

describe('describeWindowCloseRunningWork', () => {
  it('tells the user closing does not end terminals on a host they disconnected', () => {
    expect(
      describeWindowCloseRunningWork({ kind: 'user-disconnected', hostLabels: ['devbox', 'gpu'] })
    ).toBe(
      'You disconnected devbox, gpu. Closing the window does not end terminals there. Close the window anyway?'
    )
  })

  it('keeps the unreachable copy for a host that went quiet on its own', () => {
    expect(
      describeWindowCloseRunningWork({ kind: 'unverifiable', userDisconnectedHostLabels: [] })
    ).toBe(
      'A remote host could not be reached, so Orca cannot tell whether work is still running there. Close the window anyway?'
    )
  })

  it('names both when one host was disconnected and another could not be reached', () => {
    expect(
      describeWindowCloseRunningWork({
        kind: 'unverifiable',
        userDisconnectedHostLabels: ['devbox']
      })
    ).toBe(
      'You disconnected devbox. Closing the window does not end terminals there. Another remote host could not be reached, so Orca cannot tell whether work is still running there. Close the window anyway?'
    )
  })
})
