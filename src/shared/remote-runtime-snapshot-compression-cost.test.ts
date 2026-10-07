import { expect, it } from 'vitest'
import { bandwidthResponse } from './remote-runtime-bandwidth-fixture'
import { compressRuntimeSnapshotResponse } from './remote-runtime-snapshot-compression'

it('reports bounded synchronous encoder cost without retaining per-peer dictionaries', () => {
  const input = bandwidthResponse(1, 20)
  for (let warmup = 0; warmup < 25; warmup++) {
    compressRuntimeSnapshotResponse(input)
  }
  global.gc?.()
  const before = process.memoryUsage()
  const cpuStart = process.cpuUsage()
  const timings: number[] = []
  let peakHeap = before.heapUsed
  for (let index = 0; index < 500; index++) {
    const started = performance.now()
    compressRuntimeSnapshotResponse(input)
    timings.push(performance.now() - started)
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
  }
  const cpu = process.cpuUsage(cpuStart)
  global.gc?.()
  const after = process.memoryUsage()
  timings.sort((a, b) => a - b)
  console.info(
    JSON.stringify({
      compressionCost: {
        messages: timings.length,
        inputBytes: Buffer.byteLength(input),
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallP95Ms: timings[474],
        wallMaxMs: timings[499],
        peakHeapDeltaBytes: peakHeap - before.heapUsed,
        retainedHeapDeltaBytes: after.heapUsed - before.heapUsed,
        rssDeltaBytes: after.rss - before.rss
      }
    })
  )
  expect(Buffer.byteLength(compressRuntimeSnapshotResponse(input))).toBeLessThan(
    Buffer.byteLength(input)
  )
})
