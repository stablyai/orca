// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatTerminalAttention } from './NativeChatTerminalAttention'

describe('NativeChatTerminalAttention', () => {
  afterEach(cleanup)

  it('replaces hidden Chat input with a clear terminal recovery action', () => {
    const onSwitchToTerminal = vi.fn()
    render(
      <NativeChatTerminalAttention
        attention="codex-hooks-review"
        onSwitchToTerminal={onSwitchToTerminal}
      >
        <textarea aria-label="Send a message" />
      </NativeChatTerminalAttention>
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Codex needs a security review')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Review new or changed hooks before Chat can continue.'
    )
    expect(screen.queryByRole('textbox', { name: 'Send a message' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review in Terminal' }))
    expect(onSwitchToTerminal).toHaveBeenCalledOnce()
  })

  it('renders normal Chat input when the terminal needs no attention', () => {
    render(
      <NativeChatTerminalAttention attention={null}>
        <textarea aria-label="Send a message" />
      </NativeChatTerminalAttention>
    )

    expect(screen.getByRole('textbox', { name: 'Send a message' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
