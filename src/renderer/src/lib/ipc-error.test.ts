import { describe, expect, it } from 'vitest'
import { extractIpcErrorMessage, readIpcErrorDetail, readIpcErrorMessage } from './ipc-error'

describe('readIpcErrorMessage', () => {
  it('strips the Electron invoke wrapper Electron adds to a rejected handler', () => {
    expect(
      readIpcErrorMessage(
        new Error("Error invoking remote method 'git:stage': Error: index.lock exists")
      )
    ).toBe('index.lock exists')
  })

  it('strips the handler wrapper too', () => {
    expect(
      readIpcErrorMessage(
        new Error("Error occurred in handler for 'skills:discover': EACCES: permission denied")
      )
    ).toBe('EACCES: permission denied')
  })

  it('keeps only the first line, because callers render this as a sonner title', () => {
    // Why pinned: git and SSH stderr arrive multi-line, and every caller of THIS function renders
    // it in a toast — a title or a compact description, both single rows.
    expect(
      readIpcErrorMessage(
        new Error(
          "Error invoking remote method 'fs:import': Error: EACCES: permission denied\nstack 1\nstack 2"
        )
      )
    ).toBe('EACCES: permission denied')
    expect(readIpcErrorMessage(new Error('boom\ndetail'))).toBe('boom')
  })

  it('leaves a plain message untouched', () => {
    expect(readIpcErrorMessage(new Error('Permission denied'))).toBe('Permission denied')
  })

  it('has nothing to show for a non-Error or an empty message', () => {
    expect(readIpcErrorMessage('boom')).toBeUndefined()
    expect(readIpcErrorMessage(undefined)).toBeUndefined()
    expect(readIpcErrorMessage(new Error('   '))).toBeUndefined()
    expect(
      readIpcErrorMessage(new Error("Error invoking remote method 'x': Error: "))
    ).toBeUndefined()
  })
})

describe('extractIpcErrorMessage', () => {
  it('unwraps the same way readIpcErrorMessage does', () => {
    expect(
      extractIpcErrorMessage(
        new Error("Error invoking remote method 'git:stage': Error: index.lock exists"),
        'Failed to stage.'
      )
    ).toBe('index.lock exists')
  })

  it('matches main exactly: clamps a WRAPPED multi-line message', () => {
    // Why: main's regex `(.+)` had no `s` flag, so the wrapped branch stopped at the first newline.
    // Nine pre-existing callers render this as a sonner title, a single emphasised row.
    expect(
      extractIpcErrorMessage(
        new Error("Error invoking remote method 'git:stage': Error: first\nsecond"),
        'fallback'
      )
    ).toBe('first')
  })

  it('matches main exactly: leaves an UNWRAPPED multi-line message whole', () => {
    // Why: main fell through to `err.message` when the regex did not match, so it returned the
    // whole body. Six callers feed inline error bands where clamping would drop lines 2+.
    expect(extractIpcErrorMessage(new Error('summary\ndetail'), 'fallback')).toBe('summary\ndetail')
  })

  it('falls back when the error carries nothing readable', () => {
    expect(extractIpcErrorMessage('boom', 'Failed to stage.')).toBe('Failed to stage.')
    expect(extractIpcErrorMessage(new Error('   '), 'Failed to stage.')).toBe('Failed to stage.')
  })
})

describe('readIpcErrorDetail', () => {
  const MULTILINE = new Error(
    "Error invoking remote method 'git:discard': Error: error: unable to unlink 'a': Permission denied\nerror: unable to unlink 'b': Permission denied"
  )

  it('keeps every line, because an inline band is built to show more than one', () => {
    expect(readIpcErrorDetail(MULTILINE)).toBe(
      "error: unable to unlink 'a': Permission denied\nerror: unable to unlink 'b': Permission denied"
    )
  })

  it('is the unclamped half of the pair the toast slots use', () => {
    expect(readIpcErrorMessage(MULTILINE)).toBe("error: unable to unlink 'a': Permission denied")
    // Why pinned: nine of the pre-existing callers render this as a sonner title, a single row.
    expect(extractIpcErrorMessage(MULTILINE, 'Failed.')).toBe(
      "error: unable to unlink 'a': Permission denied"
    )
  })

  it('has nothing to show for a non-Error or a blank message', () => {
    expect(readIpcErrorDetail('boom')).toBeUndefined()
    expect(readIpcErrorDetail(new Error('   '))).toBeUndefined()
  })

  it('strips a wrapper the caller embedded mid-message, keeping the caller’s own prefix', () => {
    // Why: `pty-connection/deferred-session-attach.ts` composes `SSH connection failed: ${err}`
    // around an already-wrapped message. `main` discarded the prefix; keeping it is strictly better
    // than either that or leaving the transport noise on screen.
    expect(
      extractIpcErrorMessage(
        new Error(
          "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package not found."
        ),
        'fallback'
      )
    ).toBe('SSH connection failed: Relay package not found.')
  })
})
