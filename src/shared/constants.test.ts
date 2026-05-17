import { describe, expect, it } from 'vitest'
import { getDefaultPrimarySelectionMiddleClickPaste, getDefaultSettings } from './constants'

describe('getDefaultSettings', () => {
  it('enables gitignored file decorations by default', () => {
    expect(getDefaultSettings('/tmp').showGitIgnoredFiles).toBe(true)
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
