// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSyntaxLanguage } from '@/lib/syntax-highlighting/syntax-highlighter'
import { NativeChatCodeBlock, NativeChatPlainCodeBlock } from './NativeChatCodeBlock'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NativeChatCodeBlock', () => {
  it('keeps Windows line endings through highlighting and a cached remount', async () => {
    const code = `${'const value = compute(1, "two", [3])\r\n'.repeat(400)}const lastLine = 1\r\n`
    const block = (
      <NativeChatCodeBlock language="typescript">
        <code>{code}</code>
      </NativeChatCodeBlock>
    )
    const first = render(block)
    expect(await screen.findByText('lastLine', {}, { timeout: 10_000 })).toBeInTheDocument()
    expect(first.container.querySelector('pre')?.textContent).toBe(code)
    const colored = first.container.querySelectorAll('span[style*="--syntax-dark"]').length
    expect(colored).toBeGreaterThan(0)
    first.unmount()

    const second = render(block)

    expect(second.container.querySelectorAll('span[style*="--syntax-dark"]')).toHaveLength(colored)
    expect(screen.getByText('lastLine')).toBeInTheDocument()
    expect(second.container.querySelector('pre')?.textContent).toBe(code)
  })

  it('leaves the code of a dimmed row uncolored', async () => {
    const code = <code>{'const dimmed = 1\n'}</code>
    await loadSyntaxLanguage('typescript')
    const colored = render(<NativeChatCodeBlock language="typescript">{code}</NativeChatCodeBlock>)
    expect(colored.container.querySelector('pre span')).not.toBeNull()

    const plain = render(
      <NativeChatPlainCodeBlock language="typescript">{code}</NativeChatPlainCodeBlock>
    )

    expect(plain.container.querySelector('pre span')).toBeNull()
    expect(plain.container.querySelector('pre')?.textContent).toBe('const dimmed = 1\n')
  })

  it('leaves a fence in an unknown language as plain text', async () => {
    const { container } = render(
      <NativeChatCodeBlock language="not-a-real-language">
        <code>{'plain words\n'}</code>
      </NativeChatCodeBlock>
    )
    const pre = container.querySelector('pre')

    await waitFor(() => expect(pre?.textContent).toBe('plain words\n'))
    expect(pre?.querySelector('span')).toBeNull()
  })

  it.each([
    ['with a language header', 'typescript'],
    ['without a language header', undefined]
  ])('wraps long lines only after the reader turns wrapping on (%s)', (_name, language) => {
    const { container } = render(
      <NativeChatCodeBlock language={language}>
        <code>{'const longLine = 1\n'}</code>
      </NativeChatCodeBlock>
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

  it('colors and wraps fenced code, copies its text, and confirms success', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    const code = 'const answer = 42\nconsole.log(answer)\n'
    const { container } = render(
      <NativeChatCodeBlock language="typescript">
        <code>{code}</code>
      </NativeChatCodeBlock>
    )
    const pre = container.querySelector('pre')
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    await waitFor(() => expect(pre?.querySelector('span[style*="--syntax-dark"]')).not.toBeNull(), {
      timeout: 10_000
    })

    fireEvent.click(screen.getByRole('button', { name: 'Wrap lines' }))

    expect(pre).toHaveClass('whitespace-pre-wrap')
    expect(pre?.querySelector('span[style*="--syntax-dark"]')).not.toBeNull()
    expect(pre?.textContent).toBe(code)
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(code))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('keeps wrapping to the block the reader toggled', () => {
    render(
      <>
        <NativeChatCodeBlock language="typescript">
          <code>{'first\n'}</code>
        </NativeChatCodeBlock>
        <NativeChatCodeBlock language="typescript">
          <code>{'second\n'}</code>
        </NativeChatCodeBlock>
      </>
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Wrap lines' })[0])

    expect(screen.getByRole('button', { name: 'Disable line wrap' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Wrap lines' })).toHaveLength(1)
  })

  it('shows no wrap control for an empty block', () => {
    render(<NativeChatCodeBlock language="typescript" />)

    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull()
  })
})
