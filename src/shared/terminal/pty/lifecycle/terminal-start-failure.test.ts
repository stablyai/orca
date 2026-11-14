import { describe, expect, it } from 'vitest'
import {
  classifyTerminalCreationFailure,
  formatTerminalStartFailure,
  readTerminalStartFailure,
  terminalExitError,
  terminalStartError
} from './terminal-start-failure'

const cause = {
  kind: 'exited',
  exitCode: 256,
  initialOutputDiagnostic: 'git-bash-console-capacity'
} as const

describe('producer-owned terminal failure category', () => {
  it('requires complete creation provenance and never mutates neutral input', () => {
    const neutral = Object.freeze(
      Object.assign(terminalExitError('agent_session_exited_during_start', cause, 'inc'), {
        agentSessionOperationOutcome: 'unknown'
      })
    )
    for (const result of [
      undefined,
      { id: '' },
      { id: 'pty' },
      { id: 'pty', isReattach: true },
      { id: 'pty', agentSessionEnsure: { disposition: 'adopted' } },
      { id: 'pty', incarnationId: 'replacement' }
    ]) {
      expect(classifyTerminalCreationFailure(neutral, result)).toBe(neutral)
      expect(formatTerminalStartFailure(neutral)).toBeUndefined()
    }
    const classified = classifyTerminalCreationFailure(neutral, { id: 'pty', incarnationId: 'inc' })
    expect(classified).not.toBe(neutral)
    expect(classified).toBeInstanceOf(Error)
    if (!(classified instanceof Error)) {
      throw new Error('missing classified error')
    }
    expect(classified.message).toBe(neutral.message)
    expect(classified.stack).toBe(neutral.stack)
    expect(classified).toMatchObject({
      agentSessionOperationOutcome: 'unknown',
      terminalExitIncarnationId: 'inc'
    })
    expect(readTerminalStartFailure(classified)).toEqual({ cause, incarnationId: 'inc' })
    expect(readTerminalStartFailure(neutral)).toBeUndefined()
  })

  it('preserves a finalized typed failure even when a recipient has no create or an adopted result', () => {
    const producer = terminalStartError('agent_session_exited_during_start', cause, 'inc')
    const forwarded = new Error('agent_session_operation_unknown', { cause: producer })
    expect(classifyTerminalCreationFailure(forwarded, undefined)).toBe(forwarded)
    expect(classifyTerminalCreationFailure(forwarded, { id: 'pty', isReattach: true })).toBe(
      forwarded
    )
    expect(readTerminalStartFailure(forwarded)).toEqual({ cause, incarnationId: 'inc' })
  })
})
