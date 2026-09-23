import { describe, expect, it } from 'vitest'
import {
  evaluateClaudeConfigDirAdvice,
  getClaudeConfigDirCredentialsPath
} from './claude-config-dir-advice'

describe('evaluateClaudeConfigDirAdvice', () => {
  it('stays silent for a blank draft, which is the spelling of "clear"', () => {
    expect(evaluateClaudeConfigDirAdvice({ draft: '   ', probe: null })).toBeNull()
  })

  it('flags a relative path without waiting for a probe', () => {
    expect(evaluateClaudeConfigDirAdvice({ draft: '.claude', probe: null })?.code).toBe(
      'not-absolute'
    )
  })

  it('flags the drive-relative spellings that mean a different directory per session', () => {
    expect(evaluateClaudeConfigDirAdvice({ draft: 'C:alice', probe: null })?.code).toBe(
      'not-absolute'
    )
  })

  it('accepts a Windows path from a non-Windows client, because groups sync across hosts', () => {
    expect(
      evaluateClaudeConfigDirAdvice({
        draft: 'C:\\Users\\alice\\.claude',
        probe: { directoryExists: true, signedIn: true }
      })
    ).toBeNull()
  })

  it('stays silent while the probe is still in flight', () => {
    expect(
      evaluateClaudeConfigDirAdvice({
        draft: '/home/alice/.claude',
        probe: null
      })
    ).toBeNull()
  })

  it('reports a missing directory', () => {
    expect(
      evaluateClaudeConfigDirAdvice({
        draft: '/home/alice/.claude',
        probe: { directoryExists: false, signedIn: false }
      })?.code
    ).toBe('missing-directory')
  })

  it('reports a directory that exists but does not look signed in', () => {
    expect(
      evaluateClaudeConfigDirAdvice({
        draft: '/home/alice/.claude',
        probe: { directoryExists: true, signedIn: false }
      })?.code
    ).toBe('signed-out')
  })

  it('carries a message with every code, so the dialog never renders an empty hint', () => {
    const advice = evaluateClaudeConfigDirAdvice({
      draft: '/home/alice/.claude',
      probe: { directoryExists: false, signedIn: false }
    })
    expect(advice?.message.length).toBeGreaterThan(0)
  })
})

describe('getClaudeConfigDirCredentialsPath', () => {
  it('joins under a POSIX directory', () => {
    expect(getClaudeConfigDirCredentialsPath('/home/alice/.claude')).toBe(
      '/home/alice/.claude/.credentials.json'
    )
  })

  it('joins under a Windows directory without assuming a forward slash in the input', () => {
    expect(getClaudeConfigDirCredentialsPath('C:\\Users\\alice\\.claude')).toBe(
      'C:/Users/alice/.claude/.credentials.json'
    )
  })

  it('does not double a trailing separator', () => {
    expect(getClaudeConfigDirCredentialsPath('/home/alice/.claude/')).toBe(
      '/home/alice/.claude/.credentials.json'
    )
  })
})
