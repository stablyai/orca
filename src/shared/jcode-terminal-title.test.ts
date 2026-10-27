import { describe, expect, it } from 'vitest'
import {
  getJcodeTerminalTitleActivity,
  getJcodeTerminalTitleStatus,
  isJcodeIdentityTerminalTitle,
  stripJcodeTitleStatus
} from './jcode-terminal-title'
import { detectAgentStatusFromTitle } from './agent-title-status'

// Real jcode 0.87.1 titles; capture provenance: docs/reference/jcode-hook-events.md.
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
    // Keep user/wrapper work labels; suppress only jcode’s identity/codename shape.
    expect(isJcodeIdentityTerminalTitle('Fix the greet helper')).toBe(false)
    expect(isJcodeIdentityTerminalTitle('jcode Snake · deploy the relay')).toBe(false)
    expect(isJcodeIdentityTerminalTitle('release prep · +3 -0')).toBe(false)
  })

  it('ignores empty input', () => {
    expect(isJcodeIdentityTerminalTitle('')).toBe(false)
    expect(isJcodeIdentityTerminalTitle(undefined)).toBe(false)
  })

  it.each([
    ['🐾 jcode/desert Pawprint', 'idle', null],
    ['🐾 jcode/desert Pawprint · work ~1s', 'working', 'work'],
    ['🌐 jcode/desert Pawprint · last ~3s', 'idle', 'last'],
    ['🌐 jcode/meadow Hippo · work ~1m34s', 'working', 'work'],
    ['🦨 jcode/castle Skunk', 'idle', null],
    ['🌐 jcode/castle Skunk · +2 -1 · work ~10s', 'working', 'work'],
    ['🌐 jcode/castle Skunk · +2 -1 · last ~10s', 'idle', 'last'],
    ['🐽 jcode/castle Piglet', 'idle', null],
    ['🌐 jcode/castle Piglet · work ~13s', 'working', 'work'],
    ['🌐 jcode/castle Skunk · work ~1d2h', 'working', 'work'],
    ['🌐 jcode/castle Skunk · last ~1.5s', 'idle', 'last']
  ] as const)('reads native activity from %j', (title, status, activity) => {
    expect(getJcodeTerminalTitleActivity(title)).toBe(activity)
    expect(getJcodeTerminalTitleStatus(title)).toBe(status)
    expect(detectAgentStatusFromTitle(title)).toBe(status)
  })

  it('parses conversation activity without granting title-only identity', () => {
    const title = '🌐 Fix the caiea bw-scheduler cache permission EPER… · +436 -46 · work ~53m15s'
    expect(getJcodeTerminalTitleActivity(title)).toBe('work')
    expect(getJcodeTerminalTitleStatus(title)).toBe('working')
    expect(isJcodeIdentityTerminalTitle(title)).toBe(false)
    expect(detectAgentStatusFromTitle(title)).toBeNull()
  })

  it.each(['✳', '✋', '⏲', '✦', '◇'])(
    'rejects foreign status glyph %s even with a capitalized codename',
    (glyph) => {
      expect(isJcodeIdentityTerminalTitle(`${glyph} jcode Pawprint`)).toBe(false)
    }
  )

  it.each([
    'jcode-something-else',
    'jcode-something-else · work ~10s',
    'jcode/castle Skunk · work ~oops',
    'jcode/castle Skunk · work ~',
    'jcode/castle Skunk · work 10s',
    'jcode/castle Skunk · work ~10s · renamed',
    'jcode/castle Skunk · last ~10s · +2 -1',
    'jcode/castle Skunk · +2 -1 · work ~10s trailing'
  ])('does not grant identity to malformed or nonterminal decoration in %j', (title) => {
    expect(isJcodeIdentityTerminalTitle(title)).toBe(false)
  })

  it.each([
    '',
    'Fix jcode hooks',
    'Fix jcode hooks · work ~oops',
    'Fix jcode hooks · work ~10s · renamed',
    'Fix jcode hooks · last ~10s · +2 -1'
  ])('declines activity without a final native duration in %j', (title) => {
    expect(getJcodeTerminalTitleActivity(title)).toBeNull()
    expect(getJcodeTerminalTitleStatus(title)).toBeNull()
  })
})
