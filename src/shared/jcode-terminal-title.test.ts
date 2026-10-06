import { describe, expect, it } from 'vitest'
import { isJcodeIdentityTerminalTitle, stripJcodeTitleStatus } from './jcode-terminal-title'

// Every title below was captured from a real jcode 0.87.1 TUI session; see
// docs/reference/jcode-hook-events.md.
const CAPTURED_TITLES = [
  'jcode',
  '🐍 jcode Snake',
  '🐍 jcode/creek Snake',
  '🌐 jcode Snake · work ~0s',
  '🌐 jcode Puppy · +3 -0 · last ~23s',
  'jcode Snake',
  'jcode/creek Snake',
  'jcode Snake · work ~0s',
  'jcode Snake · work ~6s',
  'jcode Snake · last ~6s',
  'jcode Puppy · +3 -0 · last ~23s'
]

describe('jcode terminal titles', () => {
  it('strips the live diff and duration segments', () => {
    expect(stripJcodeTitleStatus('jcode Puppy · +3 -0 · last ~23s')).toBe('jcode Puppy')
    expect(stripJcodeTitleStatus('🌐 jcode Puppy · +3 -0 · last ~23s')).toBe('jcode Puppy')
    expect(stripJcodeTitleStatus('jcode Snake · work ~6s')).toBe('jcode Snake')
    expect(stripJcodeTitleStatus('jcode Snake · last ~1m02s')).toBe('jcode Snake')
    expect(stripJcodeTitleStatus('jcode Snake · work ~2h05m')).toBe('jcode Snake')
  })

  it.each(CAPTURED_TITLES)('treats %j as identity, not a conversation name', (title) => {
    expect(isJcodeIdentityTerminalTitle(title)).toBe(true)
  })

  it('keeps a title the user or a wrapper actually named', () => {
    // Why: a renamed tab or a wrapper-provided label is real information and must
    // survive — only jcode's own identity+codename shape is rejected.
    expect(isJcodeIdentityTerminalTitle('Fix the greet helper')).toBe(false)
    expect(isJcodeIdentityTerminalTitle('jcode Snake · deploy the relay')).toBe(false)
    expect(isJcodeIdentityTerminalTitle('release prep · +3 -0')).toBe(false)
  })

  it('ignores empty input', () => {
    expect(isJcodeIdentityTerminalTitle('')).toBe(false)
    expect(isJcodeIdentityTerminalTitle(undefined)).toBe(false)
  })
})
