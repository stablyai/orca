/**
 * @vitest-environment happy-dom
 */
import { act, isValidElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { showAgentSessionForkWarnings } from './agent-session-fork-warning-toasts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const toastWarning = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

function renderedLines(description: ReactNode): string[] {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(<>{description}</>))
  const lines = Array.from(container.children).map((child) => child.textContent ?? '')
  act(() => root.unmount())
  return lines
}

function lastDescription(): ReactNode {
  const options: unknown = toastWarning.mock.lastCall?.[1]
  if (typeof options !== 'object' || options === null || !('description' in options)) {
    throw new Error('toast had no description')
  }
  const { description } = options
  if (typeof description !== 'string' && !isValidElement(description)) {
    throw new Error('toast description is not renderable')
  }
  return description
}

beforeEach(() => {
  toastWarning.mockReset()
})

describe('showAgentSessionForkWarnings', () => {
  it("adds the host's detail as a second line after the reason", () => {
    showAgentSessionForkWarnings(
      [
        {
          kind: 'changes-not-carried',
          reason: 'apply_failed',
          detail: 'error: pathspec did not match'
        }
      ],
      'fix-auth-fork',
      { kind: 'none' }
    )

    expect(toastWarning.mock.lastCall?.[0]).toBe(
      'Created fix-auth-fork without your uncommitted changes.'
    )
    expect(renderedLines(lastDescription())).toEqual([
      'The changes could not be applied.',
      'error: pathspec did not match'
    ])
  })

  it('truncates a long detail', () => {
    showAgentSessionForkWarnings(
      [{ kind: 'changes-not-carried', reason: 'target_dirty', detail: 'x'.repeat(500) }],
      'fix-auth-fork',
      { kind: 'none' }
    )

    const [, detail] = renderedLines(lastDescription())
    expect(detail).toBe(`${'x'.repeat(199)}…`)
  })

  it('keeps only the reason when there is no detail', () => {
    showAgentSessionForkWarnings(
      [{ kind: 'changes-not-carried', reason: 'too_large' }],
      'fix-auth-fork',
      { kind: 'none' }
    )

    expect(toastWarning).toHaveBeenCalledWith(
      'Created fix-auth-fork without your uncommitted changes.',
      { description: 'Too many new files to copy.' }
    )
  })
})
