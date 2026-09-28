import { it, expect } from 'vitest'
import { join } from 'node:path'
import { runBundledBunFixture } from '../../src/main/bundled-bun-test-execution.ts'

const binary = process.env.ORCA_OMP_PROBE_BINARY

it.skipIf(!binary || process.platform === 'win32')(
  'observes actual OMP under production owned-PTY closure policy',
  async () => {
    const output = await runBundledBunFixture(
      join(import.meta.dirname, 'omp-close-lifecycle-bun-fixture.mjs'),
      'runOmpCloseProbe',
      {
        binary,
        externalTool: process.env.ORCA_OMP_PROBE_EXTERNAL_TOOL === '1',
        shell: process.env.ORCA_OMP_PROBE_SHELL
      },
      85_000
    )
    expect(typeof output).toBe('string')
    console.log(output)
  },
  90_000
)
