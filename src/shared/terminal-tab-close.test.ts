import { describe, expect, it } from 'vitest'
import * as terminalTabClose from './terminal-tab-close'

const {
  TERMINAL_TAB_CLOSE_ACK_MARGIN_MS,
  TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS,
  TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS,
  TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS,
  TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS,
  resolveTerminalTabCloseCallerTimeoutMs
} = terminalTabClose

describe('terminal tab close deadline composition', () => {
  it('reserves the SSH worst case when provider class is unknown', () => {
    expect(TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS).toBe(30_000 + 5_000)
    expect(terminalTabClose).not.toHaveProperty('TERMINAL_TAB_POSIX_PROVIDER_TEARDOWN_TIMEOUT_MS')
  })

  it('keeps provider proof below RPC, host response, and caller deadlines', () => {
    expect(TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS).toBe(35_000)
    expect(TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS).toBe(37_000)
    expect(TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS).toBe(39_000)
    expect(TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS).toBe(40_000)
    expect(TERMINAL_TAB_CLOSE_ACK_MARGIN_MS).toBe(1_000)
    expect(TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS).toBeLessThan(
      TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS
    )
    expect(TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS).toBeLessThan(
      TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS
    )
    expect(TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS).toBeLessThan(
      TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS
    )
  })

  it.each(['session.tabs.close', 'session.tabs.closeLifecycle', 'terminal.closeTab'])(
    'floors every %s transport caller at the end-to-end budget',
    (method) => {
      expect(resolveTerminalTabCloseCallerTimeoutMs(method, 1)).toBe(
        TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS
      )
    }
  )

  it('preserves unrelated RPC timeouts', () => {
    expect(resolveTerminalTabCloseCallerTimeoutMs('status.get', 5_000)).toBe(5_000)
  })
})
