import { afterEach, describe, expect, it, vi } from 'vitest'
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

// Why: 30 call sites read this one and every one of them renders the result to a user, so any
// shape it fails to open is an envelope a user is shown. The table is the population: a shape
// that is not listed is a shape nobody has decided what to do with.
const ENVELOPE_TEXT = /Error invoking remote method|Error occurred in handler for/

const ENVELOPE_SHAPES: readonly { name: string; message: string; shown: string }[] = [
  {
    name: 'invoke wrapper around a stringified Error',
    message: "Error invoking remote method 'fs:readFile': Error: Access denied",
    shown: 'Access denied'
  },
  {
    name: 'invoke wrapper around a bare reason',
    message: "Error invoking remote method 'fs:listFiles': Permission denied",
    shown: 'Permission denied'
  },
  {
    // Why: `RuntimeRpcCallError` and `TerminalKilledError` reach the renderer this way, and the
    // class name is an implementation detail of the handler, not the reason.
    name: 'invoke wrapper around an Error subclass',
    message: "Error invoking remote method 'pty:spawn': TerminalKilledError: Session was killed",
    shown: 'Session was killed'
  },
  {
    name: 'invoke wrapper a caller has already prefixed with its own context',
    message:
      "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package not found.",
    shown: 'SSH connection failed: Relay package not found.'
  },
  {
    // Why: `(.+)` stops at the first newline, so the older reader dropped the git stderr lines
    // that name which files blocked the operation.
    name: 'invoke wrapper around a multi-line reason',
    message:
      "Error invoking remote method 'worktrees:remove': Error: fatal: cannot remove\n?? scratch.txt",
    shown: 'fatal: cannot remove\n?? scratch.txt'
  },
  {
    name: 'handler-for wrapper around a stringified Error',
    message: "Error occurred in handler for 'claudeAccounts:login': Error: Signed out",
    shown: 'Signed out'
  },
  {
    name: 'handler-for wrapper around a bare reason',
    message: "Error occurred in handler for 'aiVault:listSessions': service not ready",
    shown: 'service not ready'
  },
  {
    name: 'message-less rejection behind an invoke wrapper',
    message: "Error invoking remote method 'worktrees:remove': Error",
    shown: 'FALLBACK'
  },
  {
    name: 'message-less rejection behind a handler-for wrapper',
    message: "Error occurred in handler for 'settings:update': Error",
    shown: 'FALLBACK'
  },
  {
    name: 'invoke wrapper with an empty tail',
    message: "Error invoking remote method 'worktrees:remove': ",
    shown: 'FALLBACK'
  },
  {
    name: 'invoke wrapper with no tail at all',
    message: "Error invoking remote method 'fs:readFile'",
    shown: 'FALLBACK'
  },
  {
    name: 'a message that never crossed IPC',
    message: 'Worktree has uncommitted changes',
    shown: 'Worktree has uncommitted changes'
  }
]

describe('extractIpcErrorMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(ENVELOPE_SHAPES)('opens $name', ({ message, shown }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(extractIpcErrorMessage(new Error(message), 'FALLBACK')).toBe(shown)
  })

  it('never renders envelope text for any known shape', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const leaked = ENVELOPE_SHAPES.filter(({ message }) =>
      ENVELOPE_TEXT.test(extractIpcErrorMessage(new Error(message), 'FALLBACK'))
    ).map(({ name }) => name)

    expect(leaked).toEqual([])
  })

  it('returns the fallback for a non-Error rejection', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(extractIpcErrorMessage('boom', 'fallback')).toBe('fallback')
  })

  // Why: the fallback is copy. Replacing an unreadable rejection with a sentence must not be the
  // last time anyone can see the rejection itself.
  it('keeps the rejection reachable when it renders the fallback instead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rejection = new Error("Error invoking remote method 'worktrees:remove': Error")

    expect(extractIpcErrorMessage(rejection, 'fallback')).toBe('fallback')
    expect(warn).toHaveBeenCalledWith(expect.any(String), rejection)
  })

  it('does not log when the rejection was readable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      extractIpcErrorMessage(
        new Error("Error invoking remote method 'fs:readFile': Error: Access denied"),
        'fallback'
      )
    ).toBe('Access denied')
    expect(warn).not.toHaveBeenCalled()
  })
})
