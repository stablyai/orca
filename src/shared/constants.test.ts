import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultPrimarySelectionMiddleClickPaste, getDefaultSettings } from './constants'

describe('getDefaultSettings', () => {
  it('enables gitignored file decorations by default', () => {
    expect(getDefaultSettings('/tmp').showGitIgnoredFiles).toBe(true)
  })

  it('uses list view for Source Control changes by default', () => {
    expect(getDefaultSettings('/tmp').sourceControlViewMode).toBe('list')
  })

  it('enables separate light terminal theme by default', () => {
    expect(getDefaultSettings('/tmp').terminalUseSeparateLightTheme).toBe(true)
  })

  it('enables AI commit messages by default without pinning a separate agent', () => {
    expect(getDefaultSettings('/tmp').commitMessageAi).toMatchObject({
      enabled: true,
      agentId: null,
      selectedModelByAgent: {}
    })
  })

  it('default settings include empty claudeAccountIdByWorkspace map (P2)', () => {
    const settings = getDefaultSettings('/tmp')
    expect(settings.claudeAccountIdByWorkspace).toEqual({})
  })
})

describe('claudeMultiProviderEnabled default', () => {
  const original = process.env.ORCA_RELEASE_CHANNEL
  beforeEach(() => {
    delete process.env.ORCA_RELEASE_CHANNEL
  })
  afterEach(() => {
    if (original === undefined) {
      delete process.env.ORCA_RELEASE_CHANNEL
    } else {
      process.env.ORCA_RELEASE_CHANNEL = original
    }
  })

  // Why: P4 ships multi-provider on by default. The release-channel env var is
  // a hot-fix release valve — a single-line override can re-disable shipped
  // binaries without a re-release.

  it('defaults true when ORCA_RELEASE_CHANNEL=canary', () => {
    process.env.ORCA_RELEASE_CHANNEL = 'canary'
    expect(getDefaultSettings('/tmp').claudeMultiProviderEnabled).toBe(true)
  })

  it('defaults true when ORCA_RELEASE_CHANNEL=stable', () => {
    process.env.ORCA_RELEASE_CHANNEL = 'stable'
    expect(getDefaultSettings('/tmp').claudeMultiProviderEnabled).toBe(true)
  })

  it('defaults true when ORCA_RELEASE_CHANNEL is unset (dev builds)', () => {
    delete process.env.ORCA_RELEASE_CHANNEL
    expect(getDefaultSettings('/tmp').claudeMultiProviderEnabled).toBe(true)
  })

  it('defaults false when ORCA_RELEASE_CHANNEL=disabled (release valve)', () => {
    process.env.ORCA_RELEASE_CHANNEL = 'disabled'
    expect(getDefaultSettings('/tmp').claudeMultiProviderEnabled).toBe(false)
  })
})

describe('getDefaultPrimarySelectionMiddleClickPaste', () => {
  it('enables primary selection paste on Linux by default', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('linux')).toBe(true)
  })

  it('leaves primary selection paste opt-in on macOS and Windows', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('darwin')).toBe(false)
    expect(getDefaultPrimarySelectionMiddleClickPaste('win32')).toBe(false)
  })
})
