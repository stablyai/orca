import { describe, expect, it } from 'vitest'
import {
  TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE,
  WATCHER_REMOVAL_IN_PROGRESS_MESSAGE,
  isWorktreeRemovalFenceError
} from './worktree-removal-fence-error'

describe('isWorktreeRemovalFenceError', () => {
  it('recognizes the raw terminal and watcher fence messages', () => {
    expect(isWorktreeRemovalFenceError(TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE)).toBe(true)
    expect(isWorktreeRemovalFenceError(WATCHER_REMOVAL_IN_PROGRESS_MESSAGE)).toBe(true)
  })

  it('recognizes the message after Electron IPC prefixes the reject', () => {
    // Electron wraps a rejected ipcMain.handle error with its own prefix.
    const wrapped = `Error invoking remote method 'pty:spawn': Error: ${TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE}`
    expect(isWorktreeRemovalFenceError(wrapped)).toBe(true)
  })

  it('does not match unrelated terminal errors', () => {
    expect(isWorktreeRemovalFenceError('Failed to save terminal session state')).toBe(false)
    expect(isWorktreeRemovalFenceError('shell exited with code 1')).toBe(false)
    expect(isWorktreeRemovalFenceError('')).toBe(false)
  })
})
