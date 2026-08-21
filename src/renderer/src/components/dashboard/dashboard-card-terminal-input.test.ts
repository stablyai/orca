// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  resolveDashboardCardTerminalInput,
  type DashboardCardTerminalInputState
} from './dashboard-card-terminal-input'

const MAC_ARGS = {
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  paneKey: 'tab-1:00000000-0000-4000-8000-000000000001',
  cwd: '/Users/dev/repo',
  shellOverride: undefined,
  launchAgent: undefined,
  clientPlatform: 'darwin' as NodeJS.Platform,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  osRelease: undefined
}

const WINDOWS_ARGS = {
  ...MAC_ARGS,
  cwd: 'C:\\repo',
  clientPlatform: 'win32' as NodeJS.Platform,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
  osRelease: '10.0.22631'
}

function stateWith(
  overrides: Partial<DashboardCardTerminalInputState> = {}
): Partial<DashboardCardTerminalInputState> {
  return {
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    ...overrides
  } as Partial<DashboardCardTerminalInputState>
}

function codexEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'waiting',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'codex',
    paneKey: MAC_ARGS.paneKey,
    ...overrides
  }
}

describe('resolveDashboardCardTerminalInput', () => {
  it('resolves a local macOS pane to client-host routing with kitty advertised', () => {
    expect(resolveDashboardCardTerminalInput(stateWith(), MAC_ARGS)).toEqual({
      hostPlatform: 'darwin',
      localWindowsConpty: false,
      windowsShiftEnterEncoding: 'alt-enter',
      ctrlEnterCsiU: false,
      kittyKeyboardAdvertised: true
    })
  })

  it('marks a local native Windows pane as ConPTY and withholds the kitty advertisement', () => {
    const profile = resolveDashboardCardTerminalInput(stateWith(), WINDOWS_ARGS)
    expect(profile.localWindowsConpty).toBe(true)
    expect(profile.kittyKeyboardAdvertised).toBe(false)
    expect(profile.osRelease).toBe('10.0.22631')
  })

  it('keeps the kitty advertisement on ConPTY for an agent that needs CSI-u', () => {
    const profile = resolveDashboardCardTerminalInput(stateWith(), {
      ...WINDOWS_ARGS,
      launchAgent: 'grok'
    })
    expect(profile.localWindowsConpty).toBe(true)
    expect(profile.kittyKeyboardAdvertised).toBe(true)
  })

  it('relays trusted Ctrl+Enter authority without coupling it to Shift+Enter', () => {
    const droid = resolveDashboardCardTerminalInput(
      stateWith({
        paneForegroundAgentByPaneKey: {
          [WINDOWS_ARGS.paneKey]: {
            agent: 'droid',
            routingTrusted: true,
            shellForeground: false
          }
        }
      }),
      WINDOWS_ARGS
    )
    expect(droid.ctrlEnterCsiU).toBe(true)

    const pi = resolveDashboardCardTerminalInput(
      stateWith({
        paneForegroundAgentByPaneKey: {
          [WINDOWS_ARGS.paneKey]: {
            agent: 'pi',
            routingTrusted: true,
            shellForeground: false
          }
        }
      }),
      WINDOWS_ARGS
    )
    expect(pi.windowsShiftEnterEncoding).toBe('csi-u')
    expect(pi.ctrlEnterCsiU).toBe(false)
  })

  // Why: the pty runs Linux inside WSL, so byte protocols must follow it and
  // not the Windows client — the pane resolves this from its own session cwd.
  it('treats a WSL shell override as a non-ConPTY Linux-hosted pty', () => {
    const profile = resolveDashboardCardTerminalInput(stateWith(), {
      ...WINDOWS_ARGS,
      shellOverride: 'wsl.exe'
    })
    expect(profile.localWindowsConpty).toBe(false)
    expect(profile.kittyKeyboardAdvertised).toBe(true)
    expect(profile.hostPlatform).toBe('linux')
  })

  it('follows the WSL host for a UNC session path with no shell override', () => {
    const profile = resolveDashboardCardTerminalInput(stateWith(), {
      ...WINDOWS_ARGS,
      cwd: '\\\\wsl$\\Ubuntu\\home\\dev\\repo'
    })
    expect(profile.hostPlatform).toBe('linux')
    expect(profile.localWindowsConpty).toBe(false)
  })

  it('keeps a native Windows pane on the client host', () => {
    expect(resolveDashboardCardTerminalInput(stateWith(), WINDOWS_ARGS).hostPlatform).toBe('win32')
  })

  it('follows the SSH host platform rather than the client OS', () => {
    const state = stateWith({
      repos: [{ id: 'repo-1', connectionId: 'conn-1', executionHostId: 'ssh:conn-1' }],
      sshConnectionStates: new Map([['conn-1', { remotePlatform: 'win32' }]])
    } as unknown as Partial<DashboardCardTerminalInputState>)
    expect(resolveDashboardCardTerminalInput(state, MAC_ARGS).hostPlatform).toBe('win32')
  })

  it('relays Windows input-record paste encoding for a confirmed remote Codex pane', () => {
    const profile = resolveDashboardCardTerminalInput(
      stateWith({
        runtimeStatusByEnvironmentId: new Map([
          ['windows-box', { status: { hostPlatform: 'win32' } }]
        ]),
        agentStatusByPaneKey: { [MAC_ARGS.paneKey]: codexEntry() }
      } as unknown as Partial<DashboardCardTerminalInputState>),
      { ...MAC_ARGS, ptyId: 'remote:windows-box@@pty-1' }
    )

    expect(profile.windowsInputRecordPasteNewline).toBe('alt-enter')
    expect(profile.forceBracketedMultilineTextPaste).toBeUndefined()
  })

  it('relays bracketed multiline paste for a confirmed non-Windows Codex pane', () => {
    const profile = resolveDashboardCardTerminalInput(
      stateWith({
        agentStatusByPaneKey: { [MAC_ARGS.paneKey]: codexEntry() }
      }),
      MAC_ARGS
    )

    expect(profile.forceBracketedMultilineTextPaste).toBe(true)
    expect(profile.windowsInputRecordPasteNewline).toBeUndefined()
  })

  it('does not relay stale restored agent paste authority', () => {
    const profile = resolveDashboardCardTerminalInput(
      stateWith({
        runtimeStatusByEnvironmentId: new Map([
          ['windows-box', { status: { hostPlatform: 'win32' } }]
        ]),
        agentStatusByPaneKey: {
          [MAC_ARGS.paneKey]: codexEntry({ restoredUnconfirmed: true })
        }
      } as unknown as Partial<DashboardCardTerminalInputState>),
      { ...MAC_ARGS, ptyId: 'remote:windows-box@@pty-1' }
    )

    expect(profile.forceBracketedMultilineTextPaste).toBeUndefined()
    expect(profile.windowsInputRecordPasteNewline).toBeUndefined()
  })

  it("keeps the live SSH PTY's host after the worktree owner changes", () => {
    const state = stateWith({
      sshConnectionStates: new Map([['conn-live', { remotePlatform: 'win32' }]])
    } as unknown as Partial<DashboardCardTerminalInputState>)
    const profile = resolveDashboardCardTerminalInput(state, {
      ...MAC_ARGS,
      ptyId: 'ssh:conn-live@@pty-1'
    })
    expect(profile.hostPlatform).toBe('win32')
    expect(profile.localWindowsConpty).toBe(false)
  })

  it("keeps the live runtime PTY's host after the worktree owner changes", () => {
    const state = stateWith({
      runtimeStatusByEnvironmentId: new Map([['env-live', { status: { hostPlatform: 'linux' } }]])
    } as unknown as Partial<DashboardCardTerminalInputState>)
    const profile = resolveDashboardCardTerminalInput(state, {
      ...WINDOWS_ARGS,
      ptyId: 'remote:env-live@@pty-1'
    })
    expect(profile.hostPlatform).toBe('linux')
    expect(profile.localWindowsConpty).toBe(false)
    expect(profile.kittyKeyboardAdvertised).toBe(true)
  })

  it('degrades to client-OS routing when the store has not hydrated', () => {
    expect(resolveDashboardCardTerminalInput({}, MAC_ARGS)).toEqual({
      hostPlatform: 'darwin',
      localWindowsConpty: false,
      windowsShiftEnterEncoding: 'alt-enter',
      ctrlEnterCsiU: false,
      kittyKeyboardAdvertised: true
    })
  })

  it('does not enumerate unrelated store slices per card', () => {
    const state = stateWith() as Partial<DashboardCardTerminalInputState> & {
      unrelatedSlice?: unknown
    }
    Object.defineProperty(state, 'unrelatedSlice', {
      enumerable: true,
      get: () => {
        throw new Error('unrelated store slice was read')
      }
    })
    expect(() => resolveDashboardCardTerminalInput(state, MAC_ARGS)).not.toThrow()
  })
})
