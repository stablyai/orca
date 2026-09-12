import { describe, expect, it } from 'vitest'
import { extractIpcErrorMessage, readableIpcErrorMessage } from './ipc-error'

describe('readableIpcErrorMessage', () => {
  it('strips the channel and the error class a failed removal arrives wrapped in (#19334)', () => {
    expect(
      readableIpcErrorMessage(
        "Error invoking remote method 'worktrees:remove': WorktreeArchiveHookFailedError: " +
          'Archive hook failed for worktree: /w/feature — exited 23.'
      )
    ).toBe('Archive hook failed for worktree: /w/feature — exited 23.')
  })

  it('strips a plain Error class too', () => {
    expect(
      readableIpcErrorMessage("Error invoking remote method 'worktrees:remove': Error: boom")
    ).toBe('boom')
  })

  it('leaves an unwrapped message alone, class prefix included', () => {
    expect(readableIpcErrorMessage('TypeError: x is not a function')).toBe(
      'TypeError: x is not a function'
    )
    expect(readableIpcErrorMessage('Worktree is locked by Git.')).toBe('Worktree is locked by Git.')
  })

  it('keeps a message that only looks like a wrapper', () => {
    expect(readableIpcErrorMessage('Error invoking remote method without a channel')).toBe(
      'Error invoking remote method without a channel'
    )
  })
})

// Guards the difference from the incumbent helper, which stops at the first newline and would
// drop a failed hook's output.
describe('extractIpcErrorMessage vs readableIpcErrorMessage', () => {
  const wrapped =
    "Error invoking remote method 'worktrees:remove': Error: Archive hook failed.\nbackup target unreachable"

  it('keeps the detail lines the single-line extractor drops', () => {
    expect(extractIpcErrorMessage(new Error(wrapped), 'fallback')).toBe('Archive hook failed.')
    expect(readableIpcErrorMessage(wrapped)).toBe('Archive hook failed.\nbackup target unreachable')
  })
})
