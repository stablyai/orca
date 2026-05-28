import { describe, expect, it } from 'vitest'
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

  it('enables Source Control AI by default without pinning a separate agent', () => {
    expect(getDefaultSettings('/tmp').commitMessageAi).toMatchObject({
      enabled: true,
      agentId: null,
      selectedModelByAgent: {}
    })
    expect(getDefaultSettings('/tmp').sourceControlAi).toMatchObject({
      enabled: true,
      agentId: null,
      selectedModelByAgent: {},
      instructionsByOperation: {
        commitMessage: '',
        pullRequest: '',
        branchName: ''
      }
    })
  })
})

describe('getDefaultPrimarySelectionMiddleClickPaste', () => {
  it('enables primary selection paste on Linux by default', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('linux')).toBe(true)
  })

  it('enables primary selection paste on macOS by default', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('darwin')).toBe(true)
  })

  it('leaves primary selection paste opt-in on Windows', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('win32')).toBe(false)
  })
})
