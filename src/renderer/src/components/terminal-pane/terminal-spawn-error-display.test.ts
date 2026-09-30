import { describe, expect, it, vi } from 'vitest'
import {
  LEGACY_PTY_ALLOCATION_HINT,
  LEGACY_TERMINAL_PROCESS_LIMIT_HINT,
  PTY_ALLOCATION_HINT,
  TERMINAL_PROCESS_LIMIT_HINT
} from '../../../../shared/terminal-spawn-error-copy'

// Why a locale stand-in: English fallbacks equal the host copy, so only a translation shows the swap.
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) =>
    ({
      'auto.components.terminal.pane.TerminalErrorToast.ptyAllocationLimit':
        '系统无法再分配 pty 设备。',
      'auto.components.terminal.pane.TerminalErrorToast.terminalProcessLimit':
        '系统无法再启动终端进程。'
    })[key] ?? fallback
}))

import {
  localizeTerminalSpawnHints,
  withoutTerminalSpawnIssueRequest
} from './terminal-spawn-error-display'

const RAW =
  'Failed to spawn shell "/bin/zsh": node-pty: open_slave failed: EMFILE (errno 24, Too many open files) (shell: /bin/zsh). If this persists, please file an issue.'

describe('localizeTerminalSpawnHints', () => {
  it('translates the pty allocation hint and keeps the raw diagnostic', () => {
    expect(localizeTerminalSpawnHints(`${PTY_ALLOCATION_HINT}\n${RAW}`)).toBe(
      `系统无法再分配 pty 设备。\n${RAW}`
    )
  })

  it('translates the terminal process limit hint', () => {
    expect(localizeTerminalSpawnHints(TERMINAL_PROCESS_LIMIT_HINT)).toBe('系统无法再启动终端进程。')
  })

  it('translates the multi-line hints an older host publishes', () => {
    expect(localizeTerminalSpawnHints(`${LEGACY_PTY_ALLOCATION_HINT} ${RAW}`)).toBe(
      `系统无法再分配 pty 设备。 ${RAW}`
    )
    expect(localizeTerminalSpawnHints(LEGACY_TERMINAL_PROCESS_LIMIT_HINT)).toBe(
      '系统无法再启动终端进程。'
    )
  })

  it('leaves unrelated errors untouched', () => {
    expect(localizeTerminalSpawnHints('Paste failed.')).toBe('Paste failed.')
  })
})

describe('withoutTerminalSpawnIssueRequest', () => {
  it('drops the host issue request and keeps the diagnostic', () => {
    expect(withoutTerminalSpawnIssueRequest(RAW)).toBe(
      'Failed to spawn shell "/bin/zsh": node-pty: open_slave failed: EMFILE (errno 24, Too many open files) (shell: /bin/zsh).'
    )
  })

  it('drops the request from an error before another pane error', () => {
    expect(withoutTerminalSpawnIssueRequest(`${RAW}\nPaste failed.`)).toBe(
      'Failed to spawn shell "/bin/zsh": node-pty: open_slave failed: EMFILE (errno 24, Too many open files) (shell: /bin/zsh).\nPaste failed.'
    )
  })

  it('keeps the same words when they are part of the diagnostic', () => {
    const error = `Command printed: If this persists, please file an issue.\nMore detail follows.`
    expect(withoutTerminalSpawnIssueRequest(error)).toBe(error)
  })
})
