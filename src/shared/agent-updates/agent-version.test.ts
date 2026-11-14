import { describe, expect, it } from 'vitest'
import { isUpdateAvailable, parseAgentVersion } from './agent-version'

describe('parseAgentVersion', () => {
  it('extracts the version from Claude Code output', () => {
    expect(parseAgentVersion('2.1.319 (Claude Code)')).toBe('2.1.319')
  })

  it('skips the date-style build number in Hermes output', () => {
    expect(parseAgentVersion('Hermes Agent v0.20.5 (2026.8.19) · upstream 93a29d11')).toBe('0.20.5')
  })

  it('returns null when no version is present', () => {
    expect(parseAgentVersion('no version here')).toBeNull()
  })
})

describe('isUpdateAvailable', () => {
  it('reports an update when latest is newer under semver', () => {
    expect(isUpdateAvailable('0.166.0', '0.167.0', 'semver')).toBe(true)
  })

  it('reports no update when current is newer than latest', () => {
    expect(isUpdateAvailable('2.1.320', '2.1.319', 'semver')).toBe(false)
  })

  it('compares the amp build number numerically', () => {
    expect(isUpdateAvailable('0.0.1794196844-g44d37b', '0.0.1794196999-gabc123', 'amp-build')).toBe(
      true
    )
  })

  it('ignores the suffix when the three-number core is equal', () => {
    expect(isUpdateAvailable('1.4.14-R7309.1', '1.4.14-R7400.1', 'ignore-suffix')).toBe(false)
  })

  it('compares zero-padded date-hash versions numerically under ignore-suffix', () => {
    expect(isUpdateAvailable('2025.09.12-4852336', '2026.11.05-86047df', 'ignore-suffix')).toBe(
      true
    )
  })
})
