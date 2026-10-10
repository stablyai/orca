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
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('colors a fenced block without changing its text', async () => {
    const code = 'const answer = 42\nconsole.log(answer)\n'
    const { container } = render(
      <NativeChatCodeBlock language="typescript">
        <code>{code}</code>
      </NativeChatCodeBlock>
    )
    const pre = container.querySelector('pre')

    await waitFor(
      () => {
        expect(pre?.querySelector('span[style*="--syntax-dark"]')).not.toBeNull()
      },
      { timeout: 10_000 }
    )
    expect(pre?.textContent).toBe(code)
  })

  it('keeps Windows line endings and finishes a block longer than one slice', async () => {
    const code = `${'const value = compute(1, "two", [3])\r\n'.repeat(400)}const lastLine = 1\r\n`
    const { container } = render(
      <NativeChatCodeBlock language="typescript">
        <code>{code}</code>
      </NativeChatCodeBlock>
    )

    expect(await screen.findByText('lastLine', {}, { timeout: 10_000 })).toBeInTheDocument()
    expect(container.querySelector('pre')?.textContent).toBe(code)
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

  it('paints a finished block in color at once when its row mounts again', async () => {
    // Long enough that tokenizing it again could not finish within one render.
    const block = (
      <NativeChatCodeBlock language="typescript">
        <code>{`${'const a=[1,2,3].map((x)=>x+1);f(a,{b:1,c:"s"});\n'.repeat(300)}const lastLine = 1\n`}</code>
      </NativeChatCodeBlock>
    )
    const first = render(block)
    expect(await screen.findByText('lastLine', {}, { timeout: 10_000 })).toBeInTheDocument()
    const colored = first.container.querySelectorAll('span[style*="--syntax-dark"]').length
    first.unmount()

    const second = render(block)

    expect(second.container.querySelectorAll('span[style*="--syntax-dark"]')).toHaveLength(colored)
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
})
