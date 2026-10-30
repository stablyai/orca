import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { flattenRetainedSlice } from './flatten-retained-slice'

// Use 1MB parents above V8’s SlicedString threshold so retained-parent versus copied-tail heap differences are measurable.
const PARENT_CHARS = 1024 * 1024
const TAIL_CHARS = 512
const PARENTS = 8

const retainedMeasurement = z.object({
  retainedBytes: z.number(),
  tailLengths: z.array(z.number()),
  contentMatches: z.boolean()
})
const measurement = z.object({
  node: z.string(),
  raw: retainedMeasurement,
  flattened: retainedMeasurement
})

async function measureTails(filler: string) {
  const executable = process.versions.bun
    ? (process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.env.npm_node_execpath)
    : process.execPath
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error('Expected an absolute Node executable')
  }
  const helperUrl = pathToFileURL(
    path.join(process.cwd(), 'src/renderer/src/lib/flatten-retained-slice.ts')
  ).href
  // Keep test-runner allocations outside the measured V8 heap.
  const probe = `
    import { flattenRetainedSlice } from ${JSON.stringify(helperUrl)}
    const PARENT_CHARS = ${PARENT_CHARS}
    const TAIL_CHARS = ${TAIL_CHARS}
    const PARENTS = ${PARENTS}
    function collect() {
      if (!globalThis.gc) throw new Error('global.gc unavailable - child must pass --expose-gc')
      globalThis.gc()
      globalThis.gc()
      return process.memoryUsage().heapUsed
    }
    // Distinct leading chars stop V8 sharing one backing store across the parents.
    function makeParent(index, filler) {
      return String.fromCharCode(0x41 + index) + filler.repeat(PARENT_CHARS - 1)
    }
    function retainedBytesForTails(filler, transform) {
      const parents = Array.from({ length: PARENTS }, (_unused, index) => makeParent(index, filler))
      const baseline = collect()
      const tails = parents.map((parent) => transform(parent.slice(parent.length - TAIL_CHARS)))
      // Drop the parents; only the tails stay reachable.
      parents.length = 0
      const retainedBytes = collect() - baseline
      return {
        retainedBytes,
        tailLengths: tails.map((tail) => tail.length),
        contentMatches: tails.every((tail) => tail === filler.repeat(TAIL_CHARS))
      }
    }
    const filler = ${JSON.stringify(filler)}
    const raw = retainedBytesForTails(filler, (value) => value)
    const flattened = retainedBytesForTails(filler, flattenRetainedSlice)
    process.stdout.write(JSON.stringify({ node: process.version, raw, flattened }))
  `
  const result = await runProcess({
    program: executable,
    args: [
      '--expose-gc',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--input-type=module',
      '--eval',
      probe
    ],
    cwd: process.cwd(),
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  })
  expect(result.timedOut).toBe(false)
  expect(result.signal).toBeNull()
  expect(result.code, result.stderr).toBe(0)
  expect(result.outputTruncated).not.toBe(true)
  expect(result.stderr).toBe('')
  return measurement.parse(JSON.parse(result.stdout))
}

describe('flattenRetainedSlice', () => {
  it('preserves content exactly', () => {
    expect(flattenRetainedSlice('')).toBe('')
    expect(flattenRetainedSlice('a')).toBe('a')
    const source = 'hello world, 漢字, [0m, \u{1f600}'
    expect(flattenRetainedSlice(source.slice(3))).toBe(source.slice(3))
  })

  it.each([
    ['one-byte', 'a'],
    ['two-byte', '漢']
  ])(
    'drops the %s parent a raw slice would pin',
    async (label, filler) => {
      const observed = await measureTails(filler)
      console.info('FLATTEN_RETAINED_SLICE_METRICS', label, JSON.stringify(observed))
      const { raw, flattened } = observed
      for (const tails of [raw, flattened]) {
        expect(tails.tailLengths).toHaveLength(PARENTS)
        expect(tails.tailLengths.every((length) => length === TAIL_CHARS)).toBe(true)
        expect(tails.contentMatches).toBe(true)
      }

      // A raw slice pins all 8 parents; flattening must keep only the tails.
      expect(raw.retainedBytes).toBeGreaterThan(PARENTS * PARENT_CHARS * 0.5)
      // The identity transform must fail the same ceiling applied to the real helper.
      expect(() => expect(raw.retainedBytes).toBeLessThan(PARENTS * PARENT_CHARS * 0.05)).toThrow()
      expect(flattened.retainedBytes).toBeLessThan(PARENTS * PARENT_CHARS * 0.05)
    },
    15_000
  )
})
