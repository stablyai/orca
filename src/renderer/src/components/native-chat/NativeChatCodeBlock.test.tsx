// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NativeChatCodeBlock } from './NativeChatCodeBlock'

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
})
