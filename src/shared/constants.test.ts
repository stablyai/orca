import { describe, expect, it } from 'vitest'
import { getDefaultPrimarySelectionMiddleClickPaste, getDefaultSettings } from './constants'

describe('getDefaultSettings', () => {
  it('uses platform-consistent separators for the default workspace directory', () => {
    expect(getDefaultSettings('/Users/alice').workspaceDir).toBe('/Users/alice/orca/workspaces')
    expect(getDefaultSettings('C:\\Users\\alice').workspaceDir).toBe(
      'C:\\Users\\alice\\orca\\workspaces'
    )
  })

  it('enables gitignored file decorations by default', () => {
    expect(getDefaultSettings('/tmp').showGitIgnoredFiles).toBe(true)
  })

  it('uses list view for Source Control changes by default', () => {
    expect(getDefaultSettings('/tmp').sourceControlViewMode).toBe('list')
  })

  it('keeps first-work branch auto-renaming on by default for new settings', () => {
    expect(getDefaultSettings('/tmp').autoRenameBranchFromWork).toBe(true)
    expect(getDefaultSettings('/tmp').autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('uses a block terminal cursor by default for new settings', () => {
    expect(getDefaultSettings('/tmp').terminalCursorStyle).toBe('block')
    expect(getDefaultSettings('/tmp').terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('enables separate light terminal theme by default', () => {
    expect(getDefaultSettings('/tmp').terminalUseSeparateLightTheme).toBe(true)
  })

  it('uses system language by default', () => {
    expect(getDefaultSettings('/tmp').uiLanguage).toBe('system')
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

  it('keeps compact worktree cards disabled by default', () => {
    expect(getDefaultSettings('/tmp').compactWorktreeCards).toBe(false)
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
