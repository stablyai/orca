// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatClaudeTerminalCommand } from './NativeChatClaudeTerminalCommand'
import { sendNativeChatObservedWrites } from '../../session/terminal/send/native-chat-observed-send'
import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('../../session/terminal/send/native-chat-observed-send', () => ({
  sendNativeChatObservedWrites: vi.fn()
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: vi.fn(async () => true)
}))
afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

it('runs the command in the owning PTY and allows menu navigation without clearing input', async () => {
  const command = 'mcp'
  const readDraft = vi.fn<() => string | null>(() => '')
  const cancel = vi.fn()
  vi.mocked(sendNativeChatObservedWrites).mockImplementation((_pty, _text, options) => {
    readDraft.mockReturnValue(null)
    options?.onDeliverySettled?.(true)
    return {
      cancel,
      settleAfterMs: 0,
      settled: Promise.resolve(),
      outcome: Promise.resolve('submitted'),
      bodyStarted: () => true,
      finished: () => true
    }
  })
  const readScreen = vi.fn(() => 'Manage MCP servers\n❯ figma\nEnter to select')
  const { unmount } = render(
    <NativeChatClaudeTerminalCommand
      command={command}
      ptyId="remote:windows@@pty-1"
      readScreen={readScreen}
      readDraft={readDraft}
      disabled={false}
      remote
    />,
    { wrapper: TooltipProvider }
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run in Chat' })))
  expect(document.activeElement).toBe(screen.getByLabelText('Live Claude menu'))
  expect(sendNativeChatObservedWrites).toHaveBeenCalledWith(
    'remote:windows@@pty-1',
    [
      { data: `/${command}`, delayBeforeMs: 0 },
      { data: '\r', delayBeforeMs: expect.any(Number) }
    ],
    expect.objectContaining({ clearInput: '', stopOnUnconfirmed: true })
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Next' })))
  expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(
    'remote:windows@@pty-1',
    '\x1b[B',
    'driving',
    { requireWriteSettlement: true }
  )
  await act(async () => fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }))
  expect(sendRuntimePtyInputVerified).toHaveBeenLastCalledWith(
    'remote:windows@@pty-1',
    '\x1b[A',
    'driving',
    { requireWriteSettlement: true }
  )
  vi.mocked(sendRuntimePtyInputVerified).mockClear()
  readDraft.mockReturnValue('')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Select' })))
  expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  unmount()
  expect(cancel).toHaveBeenCalledWith(true)
})

it.each(['unsent terminal draft', null])(
  'refuses to run when terminal input is %s',
  async (input) => {
    render(
      <NativeChatClaudeTerminalCommand
        command="mcp"
        ptyId="pty-1"
        readScreen={() => 'Claude'}
        readDraft={() => input}
        disabled={false}
        remote={false}
      />
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run in Chat' })))
    expect(sendNativeChatObservedWrites).not.toHaveBeenCalled()
  }
)
