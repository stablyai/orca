import { describe, expect, it } from 'vitest'
import { extractIpcErrorMessage, stripIpcInvokeEnvelope } from './ipc-error'

// Electron builds every invoke rejection in renderer/api/ipc-renderer.ts as
//   new Error(`Error invoking remote method '${channel}': ${error}`)
// where `error` is the main side's `error.toString()` (browser/api/web-contents.ts).
// Both halves of that template are reproduced below.
describe('stripIpcInvokeEnvelope', () => {
  it('returns the underlying reason', () => {
    expect(
      stripIpcInvokeEnvelope(
        "Error invoking remote method 'worktrees:remove': Error: Worktree has uncommitted changes"
      )
    ).toBe('Worktree has uncommitted changes')
  })

  it('removes an envelope a caller has already prefixed', () => {
    expect(
      stripIpcInvokeEnvelope(
        "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package not found."
      )
    ).toBe('SSH connection failed: Relay package not found.')
  })

  // Why: `String(new Error(''))` is 'Error', so a message-less handler failure reaches the
  // renderer as an envelope with only the class name behind it. Returning that remnant would
  // hand a user 'Error' as the explanation, so the whole shape counts as unreadable.
  it('reports no readable reason when only the error class survives', () => {
    expect(stripIpcInvokeEnvelope("Error invoking remote method 'worktrees:remove': Error")).toBe(
      null
    )
    expect(stripIpcInvokeEnvelope("Error invoking remote method 'worktrees:remove': ")).toBe(null)
    expect(stripIpcInvokeEnvelope("Error invoking remote method 'worktrees:remove'")).toBe(null)
  })

  it('keeps a message that never crossed IPC untouched', () => {
    expect(stripIpcInvokeEnvelope('permission denied')).toBe('permission denied')
  })

  // Why: `(.+)` in the older matcher stops at the first newline, which drops the rest of a
  // multi-line git stderr — the part naming the files that blocked the delete.
  it('keeps every line of a multi-line reason', () => {
    expect(
      stripIpcInvokeEnvelope(
        "Error invoking remote method 'worktrees:remove': Error: fatal: cannot remove\n?? scratch.txt"
      )
    ).toBe('fatal: cannot remove\n?? scratch.txt')
  })
})

// Why: 18 call sites read this one, and its documented contract is to fall back to the raw
// message rather than to null. Adding the stricter reader must not quietly retune them.
describe('extractIpcErrorMessage', () => {
  it('still unwraps the envelope', () => {
    expect(
      extractIpcErrorMessage(
        new Error("Error invoking remote method 'fs:readFile': Error: Access denied"),
        'fallback'
      )
    ).toBe('Access denied')
  })

  it('still returns the raw message when the envelope has no tail', () => {
    expect(
      extractIpcErrorMessage(new Error("Error invoking remote method 'fs:readFile'"), 'fallback')
    ).toBe("Error invoking remote method 'fs:readFile'")
  })

  it('still returns the fallback for a non-Error', () => {
    expect(extractIpcErrorMessage('boom', 'fallback')).toBe('fallback')
  })
})
