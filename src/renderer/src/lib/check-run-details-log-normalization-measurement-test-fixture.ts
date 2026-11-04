import { performance } from 'node:perf_hooks'
import { normalizeCheckRunDetailsLogTails } from './check-run-details-log-normalization'
import { checkLogDetails, checkLogJob } from './check-run-details-log-normalization-test-fixture'
import { resetOwnRetainedStringCopier } from '../../../shared/own-retained-string'
import type { PRCheckRunDetails } from '../../../shared/github/check-types'

type NormalizationTiming = {
  inputKind: 'plain' | 'malformed' | 'multibyte'
  inputBytes: number
  jobs: number
  coldMs: number
  medianMs: number
  maxTailBytes: number
}

function collectedHeap(): number {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('Measurements require Node --expose-gc')
  }
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

function retainedPayload(index: number, normalize: boolean, oversized: boolean) {
  const parent = `${index}:${String.fromCharCode(65 + index).repeat(2 * 1024 * 1024)}`
  const raw = checkLogDetails([checkLogJob(oversized ? parent : parent.slice(-16_384))])
  return normalize ? normalizeCheckRunDetailsLogTails(raw) : raw
}

function retention(normalize: boolean, oversized: boolean) {
  for (let i = 0; i < 4; i += 1) {
    normalizeCheckRunDetailsLogTails(checkLogDetails([checkLogJob('warmup'.repeat(3000))]))
  }
  const before = collectedHeap()
  const kept: (PRCheckRunDetails | null)[] = []
  for (let i = 0; i < 16; i += 1) {
    kept.push(retainedPayload(i, normalize, oversized))
  }
  const retainedBytes = collectedHeap() - before
  const tailBytes = kept.map(
    (details) => new TextEncoder().encode(details?.jobs[0].logTail ?? '').length
  )
  kept.length = 0
  return { retainedBytes, releasedBytes: collectedHeap() - before, tailBytes }
}

export function measureCheckLogNormalization() {
  Reflect.deleteProperty(globalThis, 'Buffer')
  resetOwnRetainedStringCopier()
  const timings: NormalizationTiming[] = []
  for (const inputKind of ['plain', 'malformed', 'multibyte'] as const) {
    for (const size of [16_384, 32_768, 8 * 1024 * 1024]) {
      const unit =
        inputKind === 'malformed' ? '\x1b]x\x1bPx\x9dx' : inputKind === 'multibyte' ? '漢😀' : 'x'
      const unitBytes = new TextEncoder().encode(unit).length
      for (const jobs of [1, 5]) {
        const raw = `${unit.repeat(Math.floor(size / unitBytes))}\r\nError: retained\r\tat file.ts:18:8\n`
        const payload = checkLogDetails(Array.from({ length: jobs }, (_, i) => checkLogJob(raw, i)))
        const started = performance.now()
        const first = normalizeCheckRunDetailsLogTails(payload)
        const coldMs = performance.now() - started
        for (let i = 0; i < 3; i += 1) {
          normalizeCheckRunDetailsLogTails(payload)
        }
        const samples: number[] = []
        for (let i = 0; i < 20; i += 1) {
          const start = performance.now()
          normalizeCheckRunDetailsLogTails(payload)
          samples.push(performance.now() - start)
        }
        samples.sort((a, b) => a - b)
        timings.push({
          inputKind,
          inputBytes: new TextEncoder().encode(raw).length,
          jobs,
          coldMs,
          medianMs: (samples[9] + samples[10]) / 2,
          maxTailBytes: Math.max(
            ...(first?.jobs.map((job) => new TextEncoder().encode(job.logTail ?? '').length) ?? [0])
          )
        })
      }
    }
  }
  return {
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      buffer: 'absent'
    },
    timings,
    slicedControl: retention(false, false),
    normalizedSlices: retention(true, false),
    normalizedOversized: retention(true, true)
  }
}
