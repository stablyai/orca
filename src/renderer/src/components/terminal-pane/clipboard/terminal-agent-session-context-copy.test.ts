import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'

const mockToast = {
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn()
}

const mockWriteClipboardText = vi.fn(async () => undefined)

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

vi.mock('sonner', () => ({
  toast: mockToast
}))

function makePane(capturedText: string): ManagedPane {
  return {
    leafId: LEAF_ID,
    serializeAddon: {
      serialize: vi.fn(() => capturedText)
    },
    terminal: {
      focus: vi.fn()
    }
  } as unknown as ManagedPane
}

describe('copyAgentSessionContextFromPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteClipboardText.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: { ui: { writeTerminalClipboardText: mockWriteClipboardText } }
    })
  })

  it('copies the bounded transcript without the fork prompt framing', async () => {
    const pane = makePane('User: standalone copy\nAssistant: acknowledged')
    const { copyAgentSessionContextFromPane } =
      await import('./terminal-agent-session-context-copy')

    const copied = await copyAgentSessionContextFromPane(pane)

    expect(copied).toBe(true)
    expect(mockWriteClipboardText).toHaveBeenCalledTimes(1)
    const clipped = (mockWriteClipboardText.mock.calls as unknown as string[][])[0][0]
    expect(clipped).toContain('User: standalone copy')
    // Why: standalone copy must not carry the fork header/footer the dialog adds.
    expect(clipped).not.toContain('fork of an existing Orca agent session')
    expect(clipped).not.toContain('wait for my next instruction')
    expect(mockToast.message).toHaveBeenCalledWith('Context copied')
    expect(mockToast.message).not.toHaveBeenCalledWith(
      'Fork context copied. Launch an agent and paste it to start the fork.'
    )
    expect(pane.terminal.focus).toHaveBeenCalled()
  })

  it('shows a copy-specific empty-context error without writing the clipboard', async () => {
    const pane = makePane('\x1b[0m\r\n\x1bc\x07')
    const { copyAgentSessionContextFromPane } =
      await import('./terminal-agent-session-context-copy')

    const copied = await copyAgentSessionContextFromPane(pane)

    expect(copied).toBe(false)
    expect(mockWriteClipboardText).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('No terminal context to copy')
    expect(pane.terminal.focus).toHaveBeenCalled()
  })

  it('surfaces clipboard write failures', async () => {
    mockWriteClipboardText.mockRejectedValueOnce(new Error('clipboard denied'))
    const pane = makePane('User: copy this')
    const { copyAgentSessionContextFromPane } =
      await import('./terminal-agent-session-context-copy')

    const copied = await copyAgentSessionContextFromPane(pane)

    expect(copied).toBe(false)
    expect(mockToast.error).toHaveBeenCalledWith('clipboard denied')
    expect(pane.terminal.focus).toHaveBeenCalled()
  })
})
