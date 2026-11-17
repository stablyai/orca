// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import { VmBuildStepRow } from './VmBuildStepRow'
import type { VmBuildStep } from './vm-build-steps'

afterEach(cleanup)

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

const row = (step: VmBuildStep) => (
  <ol>
    <VmBuildStepRow step={step} cloud detail={null} timing={null} t={t} />
  </ol>
)

it('reads "Get repository" until the boot plan answers, then switches in place, no placeholder bar', () => {
  const { container, rerender } = render(row(pendingClone()))
  expect(container.textContent).toContain('Get repository')
  expect(container.querySelector('[data-slot="skeleton"]')).toBeNull()
  rerender(row(pendingClone('update')))
  expect(container.textContent).toContain('Update repository')
  expect(container.textContent).not.toContain('Get repository')
  rerender(row(pendingClone('clone')))
  expect(container.textContent).toContain('Clone repository')
})
