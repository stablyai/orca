import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { buildWindowsPtyCompatibilityOptions } from './windows-pty-compatibility'
import {
  resolveRemotePtyOwnerMachinePlatform,
  type PtyOwnerMachineState
} from '@/components/terminal-pane/pty-owner-machine-platform'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
import type { SshConnectionState } from '../../../../shared/ssh-types'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('buildWindowsPtyCompatibilityOptions', () => {
  it('does not mark the row after a full-width Windows status line as wrapped', async () => {
    const options = buildWindowsPtyCompatibilityOptions({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      osRelease: '10.0.19045',
      connectionId: null,
      cwd: 'C:\\repo',
      shellOverride: null,
      executionHostId: 'local'
    })
    const terminal = new Terminal({ cols: 20, rows: 5, ...options })

    await writeTerminal(terminal, `${'─'.repeat(20)}\r\nNEXT\r\n`)

    // Old Windows wrapping falsely joins full-width rows, breaking reported Chinese scrollback.
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('NEXT')
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false)
  })
})

async function scrollbackAfterShrinkAndGrow(terminal: Terminal): Promise<number> {
  await writeTerminal(terminal, Array.from({ length: 60 }, (_, i) => `H${i}`).join('\r\n'))
  const before = terminal.buffer.active.baseY
  terminal.resize(80, 2)
  terminal.resize(80, 24)
  return terminal.buffer.active.baseY - before
}

type Owner = { executionHostId: 'runtime:env-1' | 'ssh:target-1'; runtimeEnvironmentId: null }

function ownerState(owner: Owner, platform: NodeJS.Platform): PtyOwnerMachineState {
  // SAFETY: the resolver reads only hostPlatform from a verified status.
  const status = { hostPlatform: platform } as RuntimeStatus
  // SAFETY: the resolver reads only remotePlatform from an SSH connection state.
  const ssh = { targetId: 'target-1', remotePlatform: platform } as SshConnectionState
  return owner.executionHostId === 'runtime:env-1'
    ? {
        sshConnectionStates: new Map(),
        sshStateByEnvironment: new Map(),
        runtimeStatusByEnvironmentId: new Map([['env-1', { status, checkedAt: 1 }]])
      }
    : {
        sshConnectionStates: new Map([['target-1', ssh]]),
        sshStateByEnvironment: new Map(),
        runtimeStatusByEnvironmentId: new Map()
      }
}

const PAIRED: Owner = { executionHostId: 'runtime:env-1', runtimeEnvironmentId: null }
const SSH: Owner = { executionHostId: 'ssh:target-1', runtimeEnvironmentId: null }

function remotePaneOptions(owner: Owner, state: PtyOwnerMachineState) {
  return buildWindowsPtyCompatibilityOptions({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    osRelease: '25.3.0',
    connectionId: owner.executionHostId === 'ssh:target-1' ? 'target-1' : null,
    executionHostId: owner.executionHostId,
    remoteOwnerPlatform: resolveRemotePtyOwnerMachinePlatform(state, owner)
  })
}

// A Mac client showing a remote Windows pane: pulling history into ConPTY's grid on growth left
// stale TUI frames that ConPTY never erased.
describe('a remote pane on a Mac client', () => {
  it.each([
    ['a paired Windows server', PAIRED, 'win32', true],
    ['a Windows SSH target', SSH, 'win32', true],
    ['a Linux sshd inside WSL', SSH, 'linux', false]
  ] as const)('%s uses the owner machine resize model', async (_, owner, platform, conpty) => {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 1000,
      ...remotePaneOptions(owner, ownerState(owner, platform))
    })
    const grown = await scrollbackAfterShrinkAndGrow(terminal)
    expect(conpty ? grown > 0 : grown <= 0).toBe(true)
  })

  it('applies the ConPTY model once a late server status arrives, without touching the drawn grid', async () => {
    const unknown = ownerState(PAIRED, 'win32')
    unknown.runtimeStatusByEnvironmentId = new Map()
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 1000,
      ...remotePaneOptions(PAIRED, unknown)
    })
    expect(terminal.options.windowsPty).toEqual({})
    await writeTerminal(terminal, 'FRAME-A\r\nFRAME-B')
    const drawn = [0, 1].map((y) => terminal.buffer.active.getLine(y)?.translateToString(true))

    Object.assign(terminal.options, remotePaneOptions(PAIRED, ownerState(PAIRED, 'win32')))

    expect([0, 1].map((y) => terminal.buffer.active.getLine(y)?.translateToString(true))).toEqual(
      drawn
    )
    expect(await scrollbackAfterShrinkAndGrow(terminal)).toBeGreaterThan(0)
  })
})
