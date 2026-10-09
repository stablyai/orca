// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
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
      <TooltipProvider>
        <NativeChatCodeBlock language="typescript">
          <code>{'const answer = 42\nconsole.log(answer)\n'}</code>
        </NativeChatCodeBlock>
      </TooltipProvider>
    )

    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith('const answer = 42\nconsole.log(answer)\n')
    })
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it.each([
    ['with a language header', 'typescript'],
    ['without a language header', undefined]
  ])('wraps long lines only after the reader turns wrapping on (%s)', (_name, language) => {
    const { container } = render(
      <TooltipProvider>
        <NativeChatCodeBlock language={language}>
          <code>{'const longLine = 1\n'}</code>
        </NativeChatCodeBlock>
      </TooltipProvider>
    )
    const pre = container.querySelector('pre')

    const wrapOn = screen.getByRole('button', { name: 'Wrap lines' })
    expect(wrapOn).toHaveAttribute('aria-pressed', 'false')
    expect(pre).toHaveClass('overflow-x-auto')
    expect(pre).not.toHaveClass('whitespace-pre-wrap')

    fireEvent.click(wrapOn)

    const wrapOff = screen.getByRole('button', { name: 'Disable line wrap' })
    expect(wrapOff).toHaveAttribute('aria-pressed', 'true')
    expect(pre).toHaveClass('whitespace-pre-wrap', '[overflow-wrap:anywhere]')
    expect(pre).not.toHaveClass('overflow-x-auto')

    fireEvent.click(wrapOff)

    expect(screen.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(pre).toHaveClass('overflow-x-auto')
  })

  it('keeps wrapping to the block the reader toggled', () => {
    render(
      <TooltipProvider>
        <NativeChatCodeBlock language="typescript">
          <code>{'first\n'}</code>
        </NativeChatCodeBlock>
        <NativeChatCodeBlock language="typescript">
          <code>{'second\n'}</code>
        </NativeChatCodeBlock>
      </TooltipProvider>
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Wrap lines' })[0])

    expect(screen.getByRole('button', { name: 'Disable line wrap' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Wrap lines' })).toHaveLength(1)
  })

  it('shows no wrap control for an empty block', () => {
    render(
      <TooltipProvider>
        <NativeChatCodeBlock language="typescript" />
      </TooltipProvider>
    )

    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull()
  })
})
