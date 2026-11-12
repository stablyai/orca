import { describe, expect, it } from 'vitest'
import { resolveLocalGitlabAvailable } from './use-smart-workspace-field-availability'

describe('resolveLocalGitlabAvailable', () => {
  const lastKnown = new Map([['host', true]])

  it('uses the current preflight answer when it is for this context', () => {
    expect(
      resolveLocalGitlabAvailable({
        preflightStatusCurrent: true,
        glabInstalled: false,
        contextKey: 'host',
        lastKnown
      })
    ).toBe(false)
    expect(
      resolveLocalGitlabAvailable({
        preflightStatusCurrent: true,
        glabInstalled: true,
        contextKey: 'wsl:Ubuntu',
        lastKnown
      })
    ).toBe(true)
  })

  it('keeps the last known answer while this context is being re-checked', () => {
    expect(
      resolveLocalGitlabAvailable({
        preflightStatusCurrent: false,
        glabInstalled: undefined,
        contextKey: 'host',
        lastKnown
      })
    ).toBe(true)
  })

  it('stays hidden for a context that was never checked', () => {
    expect(
      resolveLocalGitlabAvailable({
        preflightStatusCurrent: false,
        glabInstalled: undefined,
        contextKey: 'wsl:Debian',
        lastKnown
      })
    ).toBe(false)
  })
})
