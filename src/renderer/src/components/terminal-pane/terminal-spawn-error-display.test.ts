import { describe, expect, it, vi } from 'vitest'
import {
  LEGACY_PTY_ALLOCATION_HINT,
  LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
  PTY_ALLOCATION_HINT
} from '../../../../shared/terminal/pty/lifecycle/terminal-spawn-error-copy'

// Why a locale stand-in: English fallbacks equal the host copy, so only a translation shows the swap.
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) =>
    ({
      'auto.components.terminal.pane.TerminalErrorToast.ptyAllocationLimit':
        '系统无法再分配 pty 设备。',
      'auto.components.terminal.pane.TerminalErrorToast.terminalProcessLimit':
        '系统无法再启动终端进程。',
      'auto.components.terminal.pane.TerminalErrorToast.hostTerminalCap': '主机终端已达上限。'
    })[key] ?? fallback
}))

import { failedSpawnShell, localizeTerminalSpawnHints } from './terminal-spawn-error-display'

const RAW =
  'Failed to spawn shell "/bin/zsh": node-pty: open_slave failed: EMFILE (errno 24, Too many open files) (shell: /bin/zsh). If this persists, please file an issue.'

describe('localizeTerminalSpawnHints', () => {
  it('translates the pty allocation hint and keeps the raw diagnostic', () => {
    expect(localizeTerminalSpawnHints(`${PTY_ALLOCATION_HINT}\n${RAW}`)).toBe(
      `系统无法再分配 pty 设备。\n${RAW}`
    )
  })

  it('translates the multi-line hints an older host publishes', () => {
    expect(localizeTerminalSpawnHints(`${LEGACY_PTY_ALLOCATION_HINT} ${RAW}`)).toBe(
      `系统无法再分配 pty 设备。 ${RAW}`
    )
    expect(localizeTerminalSpawnHints(LEGACY_TERMINAL_PROCESS_LIMIT_HINT)).toBe(
      '系统无法再启动终端进程。'
    )
  })
})

describe('failedSpawnShell', () => {
  it('reads the shell from daemon and local spawn failures', () => {
    expect(
      failedSpawnShell(
        'Daemon failed to spawn shell "C:\\Windows\\System32\\wsl.exe" with cwd "C:\\"'
      )
    ).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(failedSpawnShell(RAW)).toBe('/bin/zsh')
    expect(failedSpawnShell('Paste failed.')).toBeNull()
  })
})
