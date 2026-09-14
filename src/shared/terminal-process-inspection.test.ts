import { describe, expect, it } from 'vitest'
import {
  classifyTerminalProcessInspectionFailure,
  isOwnerProvenTerminalAbsence
} from './terminal-process-inspection'

// O3: `terminal_gone` used to be overloaded across two evidentiary strengths (see
// docs/reference/ssh-execution-boundary.md's `terminal_gone` paragraph) -- a real relay-side
// tombstone/session-map miss (host-proven absence) and this process's own in-memory registry
// missing a record (a client-side absence: a stale handle, an exited local entry, no connected
// pty, or a "PTY not found" message). classifyTerminalProcessInspectionFailure bucketed all four
// client-side shapes under the same 'terminal_gone' string as the host's own claim.
describe('classifyTerminalProcessInspectionFailure (O3)', () => {
  it.each([
    { code: 'terminal_handle_stale', reason: 'terminal_handle_stale' },
    { code: 'terminal_exited', reason: 'terminal_exited' },
    { code: 'no_connected_pty', reason: 'no_connected_pty' }
  ])('gives $code its own reason, distinct from terminal_gone', ({ code, reason }) => {
    expect(classifyTerminalProcessInspectionFailure({ code })).toBe(reason)
    expect(classifyTerminalProcessInspectionFailure(new Error(code))).toBe(reason)
  })

  it('classifies a "PTY ... not found" message as terminal_not_found, not terminal_gone', () => {
    expect(classifyTerminalProcessInspectionFailure(new Error('PTY "term_1" not found'))).toBe(
      'terminal_not_found'
    )
  })

  it('reserves terminal_gone for the host-side claim only', () => {
    expect(classifyTerminalProcessInspectionFailure({ code: 'terminal_gone' })).toBe(
      'terminal_gone'
    )
    expect(classifyTerminalProcessInspectionFailure(new Error('terminal_gone'))).toBe(
      'terminal_gone'
    )
  })

  it('still classifies timeout, old_host and transport_loss unchanged', () => {
    expect(classifyTerminalProcessInspectionFailure(new Error('Request timed out'))).toBe('timeout')
    expect(
      classifyTerminalProcessInspectionFailure(new Error('unsupported method inspectProcess'))
    ).toBe('old_host')
    expect(
      classifyTerminalProcessInspectionFailure(new Error('SSH connection lost, reconnecting...'))
    ).toBe('transport_loss')
  })

  it('leaves an unclassified error as null so it stays a real throw', () => {
    expect(
      classifyTerminalProcessInspectionFailure(new Error('inspection invariant violated'))
    ).toBe(null)
  })
})

// O4: the one owner-proven-absence gate shared by inspectWorkerTerminal and inspectRemoteAttachment.
describe('isOwnerProvenTerminalAbsence (O4)', () => {
  it("accepts a resolved null and the owner's own terminal_gone code or message", () => {
    expect(isOwnerProvenTerminalAbsence(undefined)).toBe(true)
    expect(isOwnerProvenTerminalAbsence({ code: 'terminal_gone' })).toBe(true)
    expect(isOwnerProvenTerminalAbsence(new Error('terminal_gone'))).toBe(true)
  })

  it.each([
    Object.assign(new Error('deadline exceeded'), { code: 'request_timeout' }),
    Object.assign(new Error('terminal_handle_stale'), { code: 'terminal_handle_stale' }),
    new Error('PTY "term_1" not found'),
    new Error('boom')
  ])('rejects lost contact and client-side misses: %s', (failure) => {
    expect(isOwnerProvenTerminalAbsence(failure)).toBe(false)
  })
})
