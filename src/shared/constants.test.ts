import { describe, expect, it } from 'vitest'
import {
  getDefaultNotificationSettings,
  getDefaultPrimarySelectionMiddleClickPaste,
  getDefaultSettings,
  MAX_WEBHOOK_SERVER_PORT,
  normalizeWebhookServerSettings
} from './constants'

describe('normalizeWebhookServerSettings', () => {
  it('defaults to loopback, disabled', () => {
    expect(getDefaultSettings('/tmp').webhookServer).toEqual({
      enabled: false,
      bindAddress: '127.0.0.1',
      port: 8473
    })
  })

  it('clamps the port into the valid range', () => {
    expect(normalizeWebhookServerSettings({ port: 0 }).port).toBe(1)
    expect(normalizeWebhookServerSettings({ port: 999_999 }).port).toBe(MAX_WEBHOOK_SERVER_PORT)
    expect(normalizeWebhookServerSettings({ port: 8473.9 }).port).toBe(8473)
  })

  it('falls back to loopback for a blank bind address', () => {
    expect(normalizeWebhookServerSettings({ bindAddress: '   ' }).bindAddress).toBe('127.0.0.1')
  })

  it('merges partial updates onto current', () => {
    const current = { enabled: true, bindAddress: '0.0.0.0', port: 9000 }
    expect(normalizeWebhookServerSettings({ port: 9100 }, current)).toEqual({
      enabled: true,
      bindAddress: '0.0.0.0',
      port: 9100
    })
  })
})

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

  it('asks before closing terminals with running processes by default', () => {
    expect(getDefaultSettings('/tmp').skipCloseTerminalWithRunningProcessConfirm).toBe(false)
  })

  it('uses system language by default', () => {
    expect(getDefaultSettings('/tmp').uiLanguage).toBe('system')
  })

  it('confirms before closing pinned tabs by default', () => {
    expect(getDefaultSettings('/tmp').confirmClosePinnedTab).toBe(true)
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

  it('defaults local Windows projects to the host runtime', () => {
    expect(getDefaultSettings('/tmp').localWindowsRuntimeDefault).toEqual({
      kind: 'windows-host'
    })
  })

  it('suppresses notifications for the focused worktree by default for new users', () => {
    expect(getDefaultNotificationSettings().suppressWhenFocused).toBe(true)
    expect(getDefaultSettings('/tmp').notifications.suppressWhenFocused).toBe(true)
  })

  it('defaults agent launch args to yolo mode where the CLI supports it', () => {
    const settings = getDefaultSettings('/tmp')

    expect(settings.agentDefaultArgs).toMatchObject({
      claude: '--dangerously-skip-permissions',
      codex: '--dangerously-bypass-approvals-and-sandbox',
      gemini: '--yolo',
      cursor: '--yolo',
      copilot: '--yolo',
      grok: '--permission-mode bypassPermissions'
    })
    expect(settings.agentDefaultArgs).not.toHaveProperty('opencode')
    expect(settings.agentDefaultArgs).not.toHaveProperty('kilo')
    expect(settings.agentDefaultEnv).toMatchObject({
      goose: { GOOSE_MODE: 'auto' }
    })
    expect(settings.agentYoloDefaultsMigrated).toBe(true)
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
