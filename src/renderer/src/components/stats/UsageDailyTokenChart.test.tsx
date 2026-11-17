// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeUsageDailyChart } from './ClaudeUsageDailyChart'
import { CodexUsageDailyChart } from './CodexUsageDailyChart'

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

afterEach(cleanup)

describe('UsageDailyTokenChart', () => {
  it('drops a hidden token type from the day total and brings it back', () => {
    render(
      <ClaudeUsageDailyChart
        daily={[
          {
            day: '2026-11-16',
            inputTokens: 100,
            outputTokens: 200,
            cacheReadTokens: 5_000,
            cacheWriteTokens: 300
          }
        ]}
      />
    )
    expect(screen.getByText('5.6k')).toBeTruthy()

    const cacheRead = screen.getByRole('button', { name: 'Cache read' })
    fireEvent.click(cacheRead)
    expect(cacheRead.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('600')).toBeTruthy()

    fireEvent.click(cacheRead)
    expect(screen.getByText('5.6k')).toBeTruthy()
  })

  it('keeps the last shown token type from being hidden', () => {
    render(
      <ClaudeUsageDailyChart
        daily={[
          {
            day: '2026-11-16',
            inputTokens: 100,
            outputTokens: 200,
            cacheReadTokens: 5_000,
            cacheWriteTokens: 300
          }
        ]}
      />
    )
    for (const name of ['Cache read', 'Cache write', 'Output']) {
      fireEvent.click(screen.getByRole('button', { name }))
    }
    const input = screen.getByRole('button', { name: 'Input' })
    expect(input.hasAttribute('disabled')).toBe(true)
    expect(input.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(input)
    expect(screen.getByText('100')).toBeTruthy()

    const output = screen.getByRole('button', { name: 'Output' })
    fireEvent.click(output)
    expect(input.hasAttribute('disabled')).toBe(false)
    expect(output.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the provider total until a token type is hidden', () => {
    render(
      <CodexUsageDailyChart
        reasoningIncludedInOutput
        daily={[
          {
            day: '2026-11-16',
            inputTokens: 1_000,
            cachedInputTokens: 400,
            outputTokens: 300,
            reasoningOutputTokens: 100,
            totalTokens: 1_300
          }
        ]}
      />
    )
    expect(screen.getByText('1.3k')).toBeTruthy()

    // The Output segment is drawn without reasoning, but its tooltip matches the Output tokens card.
    expect(screen.getByText('Output: 300 tokens')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cached input' }))
    expect(screen.getByText('900')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }))
    expect(screen.getByText('800')).toBeTruthy()
  })
})
