import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { expect, it } from 'vitest'

const retained = z.object({
  retainedBytes: z.number(),
  releasedBytes: z.number(),
  tailBytes: z.array(z.number())
})
const measurement = z.object({
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    buffer: z.literal('absent')
  }),
  timings: z.array(
    z.object({
      inputKind: z.enum(['plain', 'malformed', 'multibyte']),
      inputBytes: z.number(),
      jobs: z.number(),
      coldMs: z.number(),
      medianMs: z.number(),
      maxTailBytes: z.number()
    })
  ),
  slicedControl: retained,
  normalizedSlices: retained,
  normalizedOversized: retained
})

it('isolates adverse CPU and retained-payload measurements under a hard child deadline', async () => {
  const root = process.cwd()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-check-normalization-'))
  try {
    const bundle = await build({
      stdin: {
        contents:
          "import { measureCheckLogNormalization } from './check-run-details-log-normalization-measurement-test-fixture'; process.stdout.write(JSON.stringify(measureCheckLogNormalization()));",
        resolveDir: path.join(root, 'src', 'renderer', 'src', 'lib'),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false
    })
    const entry = path.join(directory, 'measure.mjs')
    await writeFile(entry, bundle.outputFiles[0].text)
    const executable = process.versions.bun
      ? (process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.env.npm_node_execpath)
      : process.execPath
    if (!executable || !path.isAbsolute(executable)) {
      throw new Error('Expected an absolute Node executable')
    }
    const result = await runProcess({
      program: executable,
      args: ['--expose-gc', entry],
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(result.outputTruncated).not.toBe(true)
    expect(result.stderr).toBe('')
    const observed = measurement.parse(JSON.parse(result.stdout))
    expect(observed.timings).toHaveLength(18)
    expect(observed.timings.every((item) => item.maxTailBytes <= 16_384)).toBe(true)
    expect(observed.slicedControl.retainedBytes).toBeGreaterThan(16 * 1024 * 1024)
    for (const owned of [observed.normalizedSlices, observed.normalizedOversized]) {
      expect(owned.retainedBytes).toBeLessThan(4 * 1024 * 1024)
      expect(owned.retainedBytes).toBeLessThan(observed.slicedControl.retainedBytes / 8)
      expect(owned.tailBytes).toHaveLength(16)
      expect(owned.tailBytes.every((bytes) => bytes === 16_384)).toBe(true)
      expect(owned.releasedBytes).toBeLessThan(4 * 1024 * 1024)
    }
    console.info('CHECK_LOG_NORMALIZATION_METRICS', JSON.stringify(observed))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
