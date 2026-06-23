import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCRIPT_TEXTAREA_ROW_SCAN_CODE_UNITS,
  getDetectedSetupScriptTextareaRows,
  getRepositoryHookScriptTextareaRows
} from './script-textarea-rows'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('script textarea row sizing', () => {
  it('matches existing row clamps for small setup and repository scripts', () => {
    expect(getDetectedSetupScriptTextareaRows('')).toBe(2)
    expect(getDetectedSetupScriptTextareaRows('pnpm install')).toBe(2)
    expect(getDetectedSetupScriptTextareaRows('a\nb\nc\nd\ne\nf\ng')).toBe(6)

    expect(getRepositoryHookScriptTextareaRows('')).toBe(4)
    expect(getRepositoryHookScriptTextareaRows('pnpm test')).toBe(4)
    expect(getRepositoryHookScriptTextareaRows('a\nb\nc\nd')).toBe(5)
  })

  it('clamps newline-heavy pasted scripts without splitting the full payload', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')

    expect(getDetectedSetupScriptTextareaRows('\n'.repeat(100_000))).toBe(6)
    expect(getRepositoryHookScriptTextareaRows('\n'.repeat(100_000))).toBe(14)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThan(32)
  })

  it('bounds long single-line pasted script scans used only for row sizing', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const text = 'x'.repeat(SCRIPT_TEXTAREA_ROW_SCAN_CODE_UNITS + 10_000)

    expect(getRepositoryHookScriptTextareaRows(text)).toBe(4)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBe(SCRIPT_TEXTAREA_ROW_SCAN_CODE_UNITS)
  })
})
