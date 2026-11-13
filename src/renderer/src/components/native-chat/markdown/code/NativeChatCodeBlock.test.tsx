// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
})
