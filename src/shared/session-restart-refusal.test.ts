import { describe, expect, it } from 'vitest'
import {
  SESSION_RESTART_REFUSED_BEFORE_STOP,
  isSessionRestartRefusedBeforeStop,
  sessionRestartRefusalError
} from './session-restart-refusal'

describe('isSessionRestartRefusedBeforeStop', () => {
  it('matches a raw refusal and an Electron-wrapped IPC error', () => {
    expect(isSessionRestartRefusedBeforeStop(sessionRestartRefusalError('prove'))).toBe(true)
    expect(
      isSessionRestartRefusedBeforeStop(
        new Error(
          `Error invoking remote method 'pty:spawn': Error: ${SESSION_RESTART_REFUSED_BEFORE_STOP}: prove`
        )
      )
    ).toBe(true)
    expect(isSessionRestartRefusedBeforeStop(new Error('daemon unreachable'))).toBe(false)
  })
})
