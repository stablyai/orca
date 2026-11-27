import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { useAppStore } from '@/store'
import {
  registerPtySerializer,
  registerPtyTitleSource
} from '../../snapshots/pty-buffer-serializer'
import {
  isLocalWindowsCmdPrompt,
  readLocalWindowsCmdPromptPane
} from './terminal-local-windows-cmd-conpty'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import {
  forgetLocalPtySpawnShell,
  recordLocalPtySpawnShell,
  retainLocalPtySpawnShellOnReattach
} from '../../pty-transport/ipc/local-pty-spawn-shell'

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
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'D:\\tools - local\\cmd.exe' })).toBe(true)
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
    expect(cmdPrompt({ tab: 'cmd.exe', title: `${CMD_IDLE_TITLE} - python -i cmd.exe` })).toBe(
      false
    )
    expect(cmdPrompt({ tab: 'cmd.exe', title: 'Custom dashboard cmd.exe' })).toBe(false)
  })

  it('rejects cmd outside a local ConPTY pane', () => {
    expect(cmdPrompt({ tab: 'cmd.exe', localConpty: false })).toBe(false)
    expect(cmdPrompt({ setting: 'cmd.exe', localConpty: false })).toBe(false)
  })
})

describe('Ctrl+Backspace bytes', () => {
  it('keeps Ctrl+W for child commands whose relative arguments end in cmd.exe', () => {
    for (const title of [
      `${CMD_IDLE_TITLE} - vim .\\cmd.exe`,
      `${CMD_IDLE_TITLE} - python -i tools\\cmd.exe`
    ]) {
      expect(
        resolveBackspace('win32', 'ctrlKey', () => cmdPrompt({ tab: 'cmd.exe', title }))
      ).toEqual({
        type: 'sendInput',
        data: '\x17'
      })
    }
  })

  it('uses the current PTY title and launch identity at each keypress, including replacement owners', async () => {
    const previousState = useAppStore.getState()
    vi.stubGlobal('window', {
      api: {
        pty: {
          onClearBufferRequest: () => () => {},
          onResetInputModesRequest: () => () => {},
          onSerializeBufferRequest: () => () => {}
        }
      }
    })
    const terminal = new Terminal({ allowProposedApi: true })
    const unregister = registerPtySerializer('cmd-pty', () => null)
    const unregisterTitle = registerPtyTitleSource('cmd-pty', (handler) =>
      terminal.onTitleChange(handler)
    )
    const write = (title: string) =>
      new Promise<void>((resolve) => terminal.write(`\x1b]0;${title}\x07`, resolve))
    const read = () =>
      resolveBackspace('win32', 'ctrlKey', () =>
        readLocalWindowsCmdPromptPane({
          isWindows: true,
          tabId: 'cmd-tab',
          pane: { id: 3, leafId: '00000003-0000-4000-8000-000000000000' },
          transport: {
            getPtyId: () => 'cmd-pty',
            getLocalSessionMetadata: () => ({ shellOverride: 'cmd.exe' })
          },
          isLocalWindowsConpty: () => true
        })
      )
    try {
      useAppStore.setState({
        runtimePaneTitlesByTabId: { 'cmd-tab': { 2: CMD_IDLE_TITLE, 3: CMD_IDLE_TITLE } },
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: {},
        agentLaunchConfigByPaneKey: {}
      })
      await write(CMD_IDLE_TITLE)
      expect(read()).toEqual({ type: 'sendInput', data: '\b' })
      await write(`${CMD_IDLE_TITLE} - python -i cmd.exe`)
      expect(read()).toEqual({ type: 'sendInput', data: '\x17' })
      await write(CMD_IDLE_TITLE)
      useAppStore
        .getState()
        .registerAgentLaunchConfig(
          'cmd-tab:00000003-0000-4000-8000-000000000000',
          { agentArgs: '', agentEnv: {} },
          { agentType: 'claude', tabId: 'cmd-tab', leafId: '00000003-0000-4000-8000-000000000000' }
        )
      expect(read()).toEqual({ type: 'sendInput', data: '\x17' })
      useAppStore.getState().clearAgentLaunchConfig('cmd-tab:00000003-0000-4000-8000-000000000000')
      expect(read()).toEqual({ type: 'sendInput', data: '\b' })
      const unregisterReplacement = registerPtySerializer('cmd-pty', () => null)
      try {
        expect(read()).toEqual({ type: 'sendInput', data: '\x17' })
      } finally {
        unregisterReplacement()
      }
    } finally {
      unregisterTitle()
      unregister()
      terminal.dispose()
      useAppStore.setState(previousState, true)
      vi.unstubAllGlobals()
    }
  })

  it('judges the shell main started the PTY with, not a later default-shell setting', async () => {
    const previousState = useAppStore.getState()
    vi.stubGlobal('window', {
      api: {
        pty: {
          onClearBufferRequest: () => () => {},
          onResetInputModesRequest: () => () => {},
          onSerializeBufferRequest: () => () => {}
        }
      }
    })
    const terminal = new Terminal({ allowProposedApi: true })
    const unregister = registerPtySerializer('spawn-pty', () => null)
    const unregisterTitle = registerPtyTitleSource('spawn-pty', (handler) =>
      terminal.onTitleChange(handler)
    )
    const read = () =>
      readLocalWindowsCmdPromptPane({
        isWindows: true,
        tabId: 'spawn-tab',
        pane: { id: 1, leafId: '00000001-0000-4000-8000-000000000000' },
        transport: {
          getPtyId: () => 'spawn-pty',
          getLocalSessionMetadata: () => ({})
        },
        isLocalWindowsConpty: () => true
      })
    const setShellSetting = (terminalWindowsShell: string) =>
      useAppStore.setState({
        settings: {
          ...previousState.settings,
          terminalWindowsShell
        } as typeof previousState.settings
      })
    try {
      useAppStore.setState({
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: {},
        agentLaunchConfigByPaneKey: {}
      })
      await new Promise<void>((resolve) => terminal.write(`\x1b]0;${CMD_IDLE_TITLE}\x07`, resolve))

      // Started as cmd, then the default switched to PowerShell: still cmd.
      recordLocalPtySpawnShell('spawn-pty', 'inc-1', 'C:\\Windows\\System32\\cmd.exe')
      setShellSetting('powershell.exe')
      expect(read()).toBe(true)

      // Started as PowerShell, then the default switched to cmd: not cmd.
      recordLocalPtySpawnShell('spawn-pty', 'inc-2', 'powershell.exe')
      setShellSetting('cmd.exe')
      expect(read()).toBe(false)

      // A reattach to the same incarnation keeps the record; a different one drops it.
      retainLocalPtySpawnShellOnReattach('spawn-pty', 'inc-2')
      expect(read()).toBe(false)
      retainLocalPtySpawnShellOnReattach('spawn-pty', 'inc-other')
      expect(read()).toBe(true)

      // With no record (older main, or exited), fall back to the setting.
      recordLocalPtySpawnShell('spawn-pty', 'inc-3', 'powershell.exe')
      forgetLocalPtySpawnShell('spawn-pty')
      expect(read()).toBe(true)
    } finally {
      forgetLocalPtySpawnShell('spawn-pty')
      unregisterTitle()
      unregister()
      terminal.dispose()
      useAppStore.setState(previousState, true)
      vi.unstubAllGlobals()
    }
  })

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
