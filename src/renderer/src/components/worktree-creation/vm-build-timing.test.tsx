// @vitest-environment happy-dom

import { cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import {
  measuredCloudStart,
  recordCloudStartSample,
  resetCloudStartSamplesForTests,
  useVmBuildStepTimings
} from './vm-build-timing'
import { VmBuildStepRow } from './VmBuildStepRow'
import type { VmBuildStep } from './vm-build-steps'

beforeEach(() => {
  window.localStorage.clear()
  resetCloudStartSamplesForTests()
})
afterEach(cleanup)

const t: Translate = (_key, fallback, params) => {
  const seconds =
    params && typeof params === 'object' && 'seconds' in params ? String(params.seconds) : ''
  return fallback.replace('{{seconds}}', seconds)
}

it('hints from this computer’s own end-to-end starts per kind, rolling, once there are enough (JA-11)', () => {
  for (const [index, ms] of [6100, 5200, 7000, 6400].entries()) {
    recordCloudStartSample(`c${index}`, 'clone', ms)
  }
  expect(measuredCloudStart('clone')).toBeNull()
  recordCloudStartSample('c4', 'clone', 6600)
  // The same creation never counts twice.
  recordCloudStartSample('c4', 'clone', 6600)
  // Few samples: the warning threshold is at least 1.5x the median, so one outlier can't swing it.
  expect(measuredCloudStart('clone')).toEqual({ p50Ms: 6400, p95Ms: 9600 })
  // Updates (repo prebuilt) are measured apart.
  expect(measuredCloudStart('update')).toBeNull()
  expect(
    renderHook(() => useVmBuildStepTimings(true, 'clone')).result.current.provision?.p50Ms
  ).toBe(6400)
  expect(renderHook(() => useVmBuildStepTimings(true, null)).result.current).toEqual({})
  expect(renderHook(() => useVmBuildStepTimings(false, 'clone')).result.current).toEqual({})
  // Rolling: only the last 20 count, so an old slow day falls out.
  for (let index = 0; index < 20; index++) {
    recordCloudStartSample(`fast${index}`, 'clone', 3000)
  }
  expect(measuredCloudStart('clone')).toEqual({ p50Ms: 3000, p95Ms: 3000 })
  // Persisted across restarts.
  resetCloudStartSamplesForTests()
  expect(measuredCloudStart('clone')?.p50Ms).toBe(3000)
})

const running = (elapsedMs: number): VmBuildStep => ({
  id: 'provision',
  state: 'running',
  skipped: false,
  elapsedMs,
  percent: null,
  startedAt: 0
})
const rowText = (step: VmBuildStep, timing: { p50Ms: number; p95Ms: number } | null) =>
  render(
    <ol>
      <VmBuildStepRow step={step} cloud detail={null} timing={timing} t={t} />
    </ol>
  ).container.textContent

it('warns only past the measured p95, or past 30 s with no measurement (JA-11)', () => {
  expect(rowText(running(7000), null)).not.toContain('Taking longer')
  cleanup()
  expect(rowText(running(31_000), null)).toContain('Taking longer than usual')
  cleanup()
  expect(rowText(running(7000), { p50Ms: 6000, p95Ms: 9000 })).toContain('usually ~6s')
  cleanup()
  expect(rowText(running(9500), { p50Ms: 6000, p95Ms: 9000 })).toContain('Taking longer than usual')
})
