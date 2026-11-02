import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  auditResults,
  prepareBenchmark,
  runDescriptor
} from '../../config/scripts/check-job-log-byte-cap-benchmark.mjs'
import {
  createManifest,
  selectRequiredDescriptors
} from '../../config/scripts/check-job-log-performance-cases.mjs'

const root = process.cwd()
const manifest = selectRequiredDescriptors(
  createManifest({
    capturePath: process.env.ORCA_CHECK_LOG_CAPTURE
  })
).filter((descriptor) => ['proposed', 'no-buffer', 'pinned'].includes(descriptor.arm))
let context: Awaited<ReturnType<typeof prepareBenchmark>>
const records: Awaited<ReturnType<typeof runDescriptor>>[] = []
// Manual benchmark: opt in with ORCA_CHECK_LOG_PERF=1.
const runPerformance = process.env.ORCA_CHECK_LOG_PERF === '1'

describe.runIf(runPerformance)(
  'current CI log performance regressions',
  { concurrent: false },
  () => {
    beforeAll(async () => {
      context = await prepareBenchmark(root, { compareBaseline: false })
    }, 15_000)
    afterAll(async () => {
      await context?.cleanup()
    })
    for (const descriptor of manifest) {
      it(
        descriptor.id,
        async () => {
          const record = await runDescriptor(context, descriptor)
          records.push(record)
          expect(record.id).toBe(descriptor.id)
        },
        15_000
      )
    }
    it('audits current implementation coverage and scaling', () => {
      const summary = auditResults(manifest, records, { compareBaseline: false })
      expect(summary.descriptors).toBe(manifest.length)
      expect(summary.scaling.every((item) => item.medianMs[1] <= 3 * item.medianMs[0] + 1)).toBe(
        true
      )
    })
  }
)
