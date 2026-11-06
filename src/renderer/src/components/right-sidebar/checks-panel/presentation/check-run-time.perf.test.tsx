// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const formatCalls = vi.hoisted(() => ({ count: 0 }))

// Counts how often labels rebuild their exact times, the per-row text that never depends on the clock.
vi.mock('@/components/github/pr-check-presentation', () => ({
  formatCheckTimestamp: (input: string | null | undefined) => {
    formatCalls.count += 1
    return input ?? null
  }
}))

import { CheckRunTime } from './check-run-time'

let container: HTMLDivElement
let root: Root

function rows(timed: number, untimed: number): PRCheckDetail[] {
  const base = { status: 'completed', conclusion: 'success', url: null } as const
  return [
    ...Array.from({ length: timed }, (_, i) => ({
      ...base,
      name: `timed-${i}`,
      startedAt: '2026-11-05T09:57:00Z',
      completedAt: '2026-11-05T10:00:12Z'
    })),
    ...Array.from({ length: untimed }, (_, i) => ({ ...base, name: `untimed-${i}` }))
  ]
}

function formatsPerTick(timed: number, untimed: number): number {
  act(() => {
    root.render(
      <TooltipProvider>
        {rows(timed, untimed).map((check) => (
          <CheckRunTime key={check.name} check={check} />
        ))}
      </TooltipProvider>
    )
  })
  formatCalls.count = 0
  act(() => {
    vi.advanceTimersByTime(30_000)
  })
  return formatCalls.count
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  formatCalls.count = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('CheckRunTime clock cost', () => {
  it('rebuilds no fixed text on a clock tick, at N and 10N rows', () => {
    // A tick can only move ages; exact times, durations and copy depend on data and language alone.
    expect(formatsPerTick(10, 10)).toBe(0)
    act(() => root.unmount())
    root = createRoot(container)
    expect(formatsPerTick(100, 100)).toBe(0)
  })

  it('still moves each visible age on a tick', () => {
    formatsPerTick(3, 0)
    expect(container.textContent).toContain('2h ago')
    act(() => {
      vi.advanceTimersByTime(60 * 60_000)
    })
    expect(container.textContent).toContain('3h ago')
  })
})
