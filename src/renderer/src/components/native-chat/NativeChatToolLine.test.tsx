// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatToolLine } from './NativeChatToolLine'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(cleanup)

describe('tool sentence rows', () => {
  it('keeps metadata and errors while toggling output behind the sentence', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Bash',
          input: { command: 'false' },
          exitCode: 1,
          durationMs: 1200
        }}
        result={{ type: 'tool-result', output: 'command failed', isError: true }}
      />
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAccessibleName(/Bash.*Ran.*false.*exit 1.*1s/)
    expect(screen.getByText('1s').parentElement).toHaveClass('ml-auto', 'tabular-nums', 'font-sans')
    expect(screen.queryByText('command failed')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByText('command failed')).toHaveClass(
      'text-destructive',
      'bg-chat-code-surface',
      'border-chat-code-border',
      'rounded-lg',
      'text-chat-code'
    )
    fireEvent.click(button)
    expect(screen.queryByText('command failed')).toBeNull()
  })
})
