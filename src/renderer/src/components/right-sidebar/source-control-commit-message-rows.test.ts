import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMIT_MESSAGE_ROW_SCAN_CODE_UNITS,
  getCommitMessageTextareaRows
} from './source-control-commit-message-rows'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('source-control commit message row sizing', () => {
  it('preserves the existing row clamp for ordinary commit messages', () => {
    expect(getCommitMessageTextareaRows('')).toBe(2)
    expect(getCommitMessageTextareaRows('feat: keep rows stable')).toBe(2)
    expect(getCommitMessageTextareaRows('subject\n\nbody')).toBe(3)
    expect(getCommitMessageTextareaRows('\n'.repeat(20))).toBe(12)
  })

  it('clamps newline-heavy pasted commit messages without splitting the payload', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')

    expect(getCommitMessageTextareaRows('\n'.repeat(100_000))).toBe(12)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThan(32)
  })

  it('bounds long single-line pasted commit message scans used only for row sizing', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const message = 'x'.repeat(COMMIT_MESSAGE_ROW_SCAN_CODE_UNITS + 50_000)

    expect(getCommitMessageTextareaRows(message)).toBe(2)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBe(COMMIT_MESSAGE_ROW_SCAN_CODE_UNITS)
  })
})
