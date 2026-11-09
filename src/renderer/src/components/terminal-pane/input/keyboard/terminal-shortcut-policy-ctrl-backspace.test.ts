import { describe, expect, it } from 'vitest'
import { isLocalWindowsCmdPrompt } from './terminal-local-windows-cmd-conpty'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

const CTRL_W = '\x17'
const BS = '\b'

function backspace(modifier: 'ctrlKey' | 'altKey') {
  return {
    key: 'Backspace',
    ctrlKey: modifier === 'ctrlKey',
    metaKey: false,
    altKey: modifier === 'altKey',
    shiftKey: false
  }
}

function resolveBackspace(
  platform: 'darwin' | 'linux' | 'win32',
  modifier: 'ctrlKey' | 'altKey',
  isActivePaneLocalCmdPrompt?: () => boolean
) {
  return resolveTerminalShortcutAction(
    backspace(modifier),
    platform === 'darwin',
    'false',
    0,
    platform === 'win32',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    isActivePaneLocalCmdPrompt
  )
}

const CMD_IDLE_TITLE = 'C:\\WINDOWS\\SYSTEM32\\cmd.exe'

function cmdPrompt(args: {
  tab?: string
  setting?: string
  title?: string | null
  agent?: boolean
  localConpty?: boolean
}): boolean {
  return isLocalWindowsCmdPrompt({
    tabShellOverride: args.tab,
    hostTerminalWindowsShell: args.setting,
    paneTitle: args.title === undefined ? CMD_IDLE_TITLE : args.title,
    paneHasAgent: () => args.agent === true,
    isLocalWindowsConpty: () => args.localConpty !== false
  })
}

describe('local Windows cmd prompt detection', () => {
  it('detects cmd from the tab override', () => {
    expect(cmdPrompt({ tab: 'cmd.exe' })).toBe(true)
    expect(cmdPrompt({ tab: 'cmd', setting: 'powershell.exe' })).toBe(true)
    expect(cmdPrompt({ tab: 'C:\\Windows\\System32\\cmd.exe' })).toBe(true)
  })

  it('detects cmd from the default-shell setting when the tab has no override', () => {
    expect(cmdPrompt({ setting: 'cmd.exe' })).toBe(true)
    expect(cmdPrompt({ tab: 'powershell.exe', setting: 'cmd.exe' })).toBe(false)
  })

  it('rejects cmd while an agent is in the pane', () => {
    expect(cmdPrompt({ tab: 'cmd.exe', agent: true })).toBe(false)
    expect(cmdPrompt({ setting: 'cmd.exe', agent: true })).toBe(false)
  })

  it('rejects PowerShell, pwsh, Git Bash, WSL and the platform default', () => {
    for (const shell of ['powershell.exe', 'pwsh.exe', 'git-bash', 'bash.exe', 'wsl.exe']) {
      expect(cmdPrompt({ tab: shell })).toBe(false)
      expect(cmdPrompt({ setting: shell })).toBe(false)
    }
    expect(cmdPrompt({})).toBe(false)
  })

  it('accepts cmd idle titles from any cmd.exe path', () => {
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'c:\\windows\\system32\\CMD.EXE' })).toBe(true)
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'D:\\tools\\cmd.exe ' })).toBe(true)
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'Administrator: C:\\Windows\\cmd.exe' })).toBe(true)
  })

  it('rejects a running child, a custom or missing title, and a child shell title', () => {
    expect(cmdPrompt({ tab: 'cmd.exe', title: `${CMD_IDLE_TITLE} - python` })).toBe(false)
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'foo' })).toBe(false)
    expect(cmdPrompt({ tab: 'cmd.exe', title: null })).toBe(false)
    expect(cmdPrompt({ tab: 'cmd.exe', title: '' })).toBe(false)
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'neil@host: ~' })).toBe(false)
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'MINGW64:/c/repo' })).toBe(false)
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'notcmd.exe' })).toBe(false)
  })

  it('rejects cmd outside a local ConPTY pane', () => {
    expect(cmdPrompt({ tab: 'cmd.exe', localConpty: false })).toBe(false)
    expect(cmdPrompt({ setting: 'cmd.exe', localConpty: false })).toBe(false)
  })
})

describe('Ctrl+Backspace bytes', () => {
  it('sends BS only for a local Windows cmd prompt', () => {
    expect(resolveBackspace('win32', 'ctrlKey', () => true)).toEqual({
      type: 'sendInput',
      data: BS
    })
    expect(resolveBackspace('win32', 'ctrlKey', () => false)).toEqual({
      type: 'sendInput',
      data: CTRL_W
    })
    expect(resolveBackspace('win32', 'ctrlKey')).toEqual({ type: 'sendInput', data: CTRL_W })
  })

  it('keeps Ctrl+W and Alt+Backspace on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolveBackspace(platform, 'ctrlKey')).toEqual({ type: 'sendInput', data: CTRL_W })
      expect(resolveBackspace(platform, 'altKey')).toEqual({
        type: 'sendInput',
        data: '\x1b\x7f'
      })
    }
  })
})
