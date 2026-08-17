// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_TOOL_STEP_DWELL_MS, useSettledAgentToolStep } from './use-settled-agent-tool-step'

type StepProps = { name: string; input: string }

function renderStep(initialProps: StepProps) {
  return renderHook(({ name, input }: StepProps) => useSettledAgentToolStep(name, input), {
    initialProps
  })
}

function passDwell(): void {
  act(() => {
    vi.advanceTimersByTime(AGENT_TOOL_STEP_DWELL_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSettledAgentToolStep', () => {
  it('shows the mounted step without waiting for a dwell', () => {
    const { result } = renderStep({ name: 'Read', input: 'src/main.ts' })

    expect(result.current).toEqual({ toolName: 'Read', toolInput: 'src/main.ts' })
  })

  it('holds the mounted step for one dwell before the first rewrite lands', () => {
    const { result, rerender } = renderStep({ name: '', input: '' })

    act(() => {
      rerender({ name: 'Read', input: 'src/main.ts' })
    })
    expect(result.current).toEqual({ toolName: '', toolInput: '' })

    passDwell()
    expect(result.current).toEqual({ toolName: 'Read', toolInput: 'src/main.ts' })
  })

  it('coalesces a burst of hook rewrites to the newest step', () => {
    const { result, rerender } = renderStep({ name: 'Read', input: 'a.ts' })
    passDwell()

    act(() => {
      rerender({ name: 'Read', input: 'b.ts' })
    })
    expect(result.current).toEqual({ toolName: 'Read', toolInput: 'b.ts' })

    for (const [name, input] of [
      ['Grep', 'TODO'],
      ['Edit', 'c.ts'],
      ['Bash', 'pnpm test']
    ] as [string, string][]) {
      act(() => {
        vi.advanceTimersByTime(80)
        rerender({ name, input })
      })
      // Three rewrites inside the dwell paint nothing.
      expect(result.current).toEqual({ toolName: 'Read', toolInput: 'b.ts' })
    }

    passDwell()
    // Only the newest lands — the two intermediates are never painted.
    expect(result.current).toEqual({ toolName: 'Bash', toolInput: 'pnpm test' })
  })

  it('always lands the final step once the burst stops', () => {
    const { result, rerender } = renderStep({ name: 'Read', input: 'a.ts' })
    passDwell()

    act(() => {
      rerender({ name: 'Read', input: 'b.ts' })
    })
    act(() => {
      vi.advanceTimersByTime(50)
      rerender({ name: 'Bash', input: 'pnpm build' })
    })
    passDwell()

    expect(result.current).toEqual({ toolName: 'Bash', toolInput: 'pnpm build' })
  })

  it('never pairs one step name with another step input', () => {
    const seen: string[] = []
    const { rerender } = renderHook(
      ({ name, input }: StepProps) => {
        const step = useSettledAgentToolStep(name, input)
        seen.push(`${step.toolName}|${step.toolInput}`)
        return step
      },
      { initialProps: { name: 'Read', input: 'a.ts' } }
    )
    passDwell()

    act(() => {
      rerender({ name: 'Bash', input: 'pnpm test' })
    })
    act(() => {
      vi.advanceTimersByTime(40)
      rerender({ name: 'Grep', input: 'needle' })
    })
    passDwell()

    const validPairs = new Set(['Read|a.ts', 'Bash|pnpm test', 'Grep|needle'])
    expect(seen.every((pair) => validPairs.has(pair))).toBe(true)
  })

  it('coalesces a transient clear away when a new step arrives inside the dwell', () => {
    // Why: cursor postToolUseFailure clears the pair for one event; painting that
    // blank frame is what swings the row between unrelated text (#11075).
    const { result, rerender } = renderStep({ name: 'Read', input: 'a.ts' })
    passDwell()

    act(() => {
      rerender({ name: 'Bash', input: 'pnpm test' })
    })
    act(() => {
      vi.advanceTimersByTime(30)
      rerender({ name: '', input: '' })
    })
    act(() => {
      vi.advanceTimersByTime(30)
      rerender({ name: 'Edit', input: 'fix.ts' })
    })
    expect(result.current).toEqual({ toolName: 'Bash', toolInput: 'pnpm test' })

    passDwell()
    expect(result.current).toEqual({ toolName: 'Edit', toolInput: 'fix.ts' })
  })

  it('lands a clear that outlives the dwell so a finished row drops its tool step', () => {
    const { result, rerender } = renderStep({ name: 'Read', input: 'a.ts' })
    passDwell()

    act(() => {
      rerender({ name: 'Bash', input: 'pnpm test' })
    })
    act(() => {
      vi.advanceTimersByTime(30)
      rerender({ name: '', input: '' })
    })
    passDwell()

    expect(result.current).toEqual({ toolName: '', toolInput: '' })
  })

  it('keeps repainting on schedule instead of restarting the dwell on every rewrite', () => {
    const { result, rerender } = renderStep({ name: 'Read', input: 'a.ts' })
    passDwell()

    // A hook every 50ms for well over one dwell must still land a fresh step.
    for (let elapsed = 0; elapsed <= AGENT_TOOL_STEP_DWELL_MS * 2; elapsed += 50) {
      act(() => {
        vi.advanceTimersByTime(50)
        rerender({ name: 'Bash', input: `step-${elapsed}` })
      })
    }

    expect(result.current.toolName).toBe('Bash')
    expect(result.current.toolInput).toMatch(/^step-\d+$/)
  })

  it('clears its pending dwell on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { rerender, unmount } = renderStep({ name: 'Read', input: 'a.ts' })
    passDwell()

    act(() => {
      rerender({ name: 'Bash', input: 'pnpm test' })
    })
    act(() => {
      vi.advanceTimersByTime(20)
      rerender({ name: 'Grep', input: 'needle' })
    })
    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(() => vi.advanceTimersByTime(AGENT_TOOL_STEP_DWELL_MS)).not.toThrow()
    clearTimeoutSpy.mockRestore()
  })
})
