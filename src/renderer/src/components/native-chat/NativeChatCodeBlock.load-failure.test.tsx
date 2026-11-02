// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSyntaxLanguage } from '@/lib/syntax-highlighting/syntax-highlighter'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'

// Its own file, so the regex engine has not loaded before the failure.
const oniguruma = vi.hoisted(() => ({ fails: false }))

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => {
  const { loadNodeOniguruma } = await import('@/lib/syntax-highlighting/oniguruma-test-harness')
  return {
    loadOniguruma: () =>
      oniguruma.fails ? Promise.reject(new Error('regex engine unavailable')) : loadNodeOniguruma()
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NativeChatCodeBlock grammar load failure', () => {
  it('colors a block still streaming once a failed grammar load succeeds on retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    oniguruma.fails = true
    const block = (code: string) => (
      <NativeChatCodeBlock language="rust">
        <code>{code}</code>
      </NativeChatCodeBlock>
    )
    try {
      const { container, rerender } = render(block('fn main() {\n'))
      await expect(loadSyntaxLanguage('rust')).resolves.toBe('failed')
      expect(container.querySelector('pre span')).toBeNull()

      oniguruma.fails = false
      now += 5000
      rerender(block('fn main() {\n    let answer = 42;\n'))

      await waitFor(
        () => {
          expect(container.querySelector('pre span[style*="--syntax-dark"]')).not.toBeNull()
        },
        { timeout: 10_000 }
      )
      expect(container.querySelector('pre')?.textContent).toBe(
        'fn main() {\n    let answer = 42;\n'
      )
    } finally {
      oniguruma.fails = false
    }
  })
})
