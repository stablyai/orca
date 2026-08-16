import { describe, expect, it, vi } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'
import { isWindowsGitBashPaneForShortcut } from './windows-git-bash-shortcut'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('Windows Git Bash terminal-first Ctrl+W', () => {
  const ctrlW = event({ key: 'w', code: 'KeyW', ctrlKey: true })
  const resolveWindowsCtrlW = (args: {
    terminalFirst: boolean
    gitBash: boolean
    windows: boolean
    input?: TerminalShortcutEvent
  }) =>
    resolveTerminalShortcutAction(
      args.input ?? ctrlW,
      false,
      'false',
      0,
      args.windows,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => args.windows,
      args.terminalFirst ? 'terminal-first' : 'orca-first',
      undefined,
      () => args.gitBash
    )

  it('lets Git Bash own Ctrl+W only under the Windows Terminal-first boundary', () => {
    expect(resolveWindowsCtrlW({ terminalFirst: true, gitBash: true, windows: true })).toBeNull()
    expect(resolveWindowsCtrlW({ terminalFirst: false, gitBash: true, windows: true })).toEqual({
      type: 'closeActivePane'
    })
    expect(resolveWindowsCtrlW({ terminalFirst: true, gitBash: false, windows: true })).toEqual({
      type: 'closeActivePane'
    })
    expect(resolveWindowsCtrlW({ terminalFirst: true, gitBash: true, windows: false })).toEqual({
      type: 'closeActivePane'
    })
  })

  it('keeps mismatched logical w events on the pane-close path', () => {
    expect(
      resolveWindowsCtrlW({
        terminalFirst: true,
        gitBash: true,
        windows: true,
        input: event({ key: 'w', code: 'KeyQ', ctrlKey: true })
      })
    ).toEqual({
      type: 'closeActivePane'
    })
  })

  it('uses physical KeyW across IME-rewritten logical keys', () => {
    expect(
      resolveWindowsCtrlW({
        terminalFirst: true,
        gitBash: true,
        windows: true,
        input: event({ key: 'ㅈ', code: 'KeyW', ctrlKey: true })
      })
    ).toBeNull()
    expect(
      resolveWindowsCtrlW({
        terminalFirst: true,
        gitBash: true,
        windows: true,
        input: event({ key: 'w', code: '', ctrlKey: true })
      })
    ).toBeNull()
  })

  it('does not classify modified or non-W chords as plain Ctrl+W', () => {
    const gitBash = vi.fn(() => true)
    const resolve = (input: TerminalShortcutEvent, terminalFirst = true) =>
      resolveTerminalShortcutAction(
        input,
        false,
        'false',
        0,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => true,
        terminalFirst ? 'terminal-first' : 'orca-first',
        undefined,
        gitBash
      )

    expect(resolve(event({ key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }))).toBeNull()
    resolve(event({ key: 'c', code: 'KeyC', ctrlKey: true }))
    expect(resolve(event({ key: 'w', code: 'KeyW', ctrlKey: true }), false)).toEqual({
      type: 'closeActivePane'
    })
    expect(gitBash).not.toHaveBeenCalled()
  })

  it('detects Git Bash from authoritative local session metadata', () => {
    expect(
      isWindowsGitBashPaneForShortcut({
        isWindowsTerminalHost: true,
        sessionShellOverride: 'git-bash'
      })
    ).toBe(true)
  })

  it('keeps PowerShell, cmd, remote, and non-Windows panes on the close path', () => {
    expect(
      isWindowsGitBashPaneForShortcut({
        isWindowsTerminalHost: true,
        sessionShellOverride: 'powershell.exe'
      })
    ).toBe(false)
    expect(
      isWindowsGitBashPaneForShortcut({
        isWindowsTerminalHost: true,
        sessionShellOverride: 'cmd.exe'
      })
    ).toBe(false)
    expect(
      isWindowsGitBashPaneForShortcut({
        isWindowsTerminalHost: true,
        sessionShellOverride: undefined
      })
    ).toBe(false)
    expect(
      isWindowsGitBashPaneForShortcut({
        isWindowsTerminalHost: false,
        sessionShellOverride: 'git-bash'
      })
    ).toBe(false)
  })
})
