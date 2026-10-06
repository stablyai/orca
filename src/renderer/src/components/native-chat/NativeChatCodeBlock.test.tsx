// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NativeChatCodeBlock', () => {
  it('shows a plain language label without a header icon or divider', () => {
    const { container } = render(<NativeChatCodeBlock language="typescript" />)
    const label = screen.getByText('TypeScript').closest('[data-code-language]')
    const header = label?.parentElement

    expect(label).toHaveClass('font-sans', 'text-xs', 'text-chat-foreground-faint')
    expect(header).toHaveClass('h-7.5')
    expect(header).not.toHaveClass('border-b', 'border-border/60')
    expect(header?.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')).toHaveClass('px-3.5', 'pt-0.5', 'pb-3')
  })

  it('copies only the fenced code and confirms success', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })

    render(
      <NativeChatCodeBlock language="typescript">
        <code>{'const answer = 42\nconsole.log(answer)\n'}</code>
      </NativeChatCodeBlock>
    )

    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('const answer = 42\nconsole.log(answer)\n')
    })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
