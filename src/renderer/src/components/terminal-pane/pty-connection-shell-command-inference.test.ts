import { describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_INTERRUPT_ETX,
  TERMINAL_INTERRUPT_KITTY_CTRL_C
} from '../../../../shared/terminal-interrupt-bytes'
import { observeAcceptedShellCommandInput } from './pty-connection/shell-command-inference'

function buildState() {
  const requestReconfirmation = vi.fn()
  const state = {
    commandInferredPaneAgent: null,
    requestKnownWindowsShiftEnterReconfirmation: requestReconfirmation,
    hasFreshPaneAgentSurface: vi.fn(() => false),
    shellCommandInferenceSuspendedUntilCommandEnd: false,
    pendingShellCommandLine: '',
    pendingShellCommandCursor: 0,
    resetPendingShellCommandLine: vi.fn(),
    rememberCommandInferredPaneAgent: vi.fn(),
    deletePendingShellCommandCharacter: vi.fn(),
    deletePendingShellCommandWord: vi.fn(),
    consumeShellCommandCsiSequence: vi.fn(() => null),
    appendPendingShellCommandInput: vi.fn((text: string) => {
      state.pendingShellCommandLine =
        state.pendingShellCommandLine.slice(0, state.pendingShellCommandCursor) +
        text +
        state.pendingShellCommandLine.slice(state.pendingShellCommandCursor)
      state.pendingShellCommandCursor += text.length
    })
  }
  state.resetPendingShellCommandLine = vi.fn(() => {
    state.pendingShellCommandLine = ''
    state.pendingShellCommandCursor = 0
  })

  return { state, requestReconfirmation }
}

describe('shell command inference Ctrl+C handling', () => {
  it.each([
    ['ETX', TERMINAL_INTERRUPT_ETX],
    ['Kitty CSI-u', TERMINAL_INTERRUPT_KITTY_CTRL_C]
  ])('clears the partial command and requests reconfirmation for %s', (_label, interrupt) => {
    const { state, requestReconfirmation } = buildState()

    state.pendingShellCommandLine = 'claude --resume'
    state.pendingShellCommandCursor = state.pendingShellCommandLine.length
    observeAcceptedShellCommandInput(state, `claude --resume${interrupt}`)

    expect(state.pendingShellCommandLine).toBe('')
    expect(state.pendingShellCommandCursor).toBe(0)
    expect(requestReconfirmation).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    ['ETX', TERMINAL_INTERRUPT_ETX],
    ['Kitty CSI-u', TERMINAL_INTERRUPT_KITTY_CTRL_C]
  ])(
    'cancels suspended inference when %s is embedded in an accepted chunk',
    (_label, interrupt) => {
      const { state, requestReconfirmation } = buildState()

      state.pendingShellCommandLine = 'partial command'
      state.pendingShellCommandCursor = state.pendingShellCommandLine.length
      state.shellCommandInferenceSuspendedUntilCommandEnd = true
      observeAcceptedShellCommandInput(state, `partial command${interrupt}`)

      expect(state.shellCommandInferenceSuspendedUntilCommandEnd).toBe(false)
      expect(state.pendingShellCommandLine).toBe('')
      expect(requestReconfirmation).toHaveBeenCalledExactlyOnceWith()
    }
  )
})
