// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { VmBuildStepRow } from './VmBuildStepRow'
import type { VmBuildStep } from './vm-build-steps'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t: Translate = (_key, fallback) => fallback
const pendingClone = (cloneMode?: 'clone' | 'update'): VmBuildStep => ({
  id: 'clone',
  state: 'pending',
  skipped: false,
  elapsedMs: null,
  percent: null,
  startedAt: null,
  ...(cloneMode ? { cloneMode } : {})
})

it('names the repository row once: no label guessed, a placeholder only after 150 ms (PC-4)', () => {
  vi.useFakeTimers()
  const row = (step: VmBuildStep) => (
    <ol>
      <VmBuildStepRow step={step} cloud detail={null} timing={null} t={t} />
    </ol>
  )
  const { container, rerender } = render(row(pendingClone()))
  // Accessible name only; no visible label, no placeholder yet (the plan usually answers by now).
  expect(container.textContent).toContain('Repository')
  expect(container.textContent).not.toContain('Clone repository')
  expect(container.querySelector('[data-slot="skeleton"]')).toBeNull()
  act(() => {
    vi.advanceTimersByTime(160)
  })
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
  // The plan answers: the one label, never changed afterwards.
  rerender(row(pendingClone('update')))
  expect(container.querySelector('[data-slot="skeleton"]')).toBeNull()
  expect(container.textContent).toContain('Update repository')
})

it('names an undecided repository step neutrally once the start has failed (N-12)', () => {
  const { container } = render(
    <ol>
      <VmBuildStepRow step={pendingClone()} cloud detail={null} timing={null} stopped t={t} />
    </ol>
  )
  expect(container.textContent).toContain('Get repository')
  expect(container.querySelector('[data-slot="skeleton"]')).toBeNull()
})
