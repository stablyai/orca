import type * as fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { buildPacedTypingMeasurement } from './paced-terminal-typing-measurement'

const output = vi.hoisted(() => ({ json: '' }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  readFileSync: () => Buffer.from('benchmark build'),
  readdirSync: () => ['index.js'],
  mkdirSync: () => undefined,
  writeFileSync: (_path: string, json: string) => {
    output.json = json
  }
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('writes applied workspace-update conditions despite conflicting requested load flags', async () => {
  vi.stubEnv('ORCA_TYPING_BENCH_CPU_WORKERS', '4')
  vi.stubEnv('ORCA_TYPING_BENCH_PTY_METADATA', '1')
  vi.stubEnv('ORCA_TYPING_BENCH_METADATA_STATUS', '1')
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const { writeBenchReport } = await import('./multi-workspace-typing-bench')
  const measurement = buildPacedTypingMeasurement({
    keyCount: 1,
    plannedAtBySeq: new Map([[1, 100]]),
    sentAtBySeq: new Map([[1, 100]]),
    arrivals: new Map([[1, { seq: 1, atMs: 110, char: 'a' }]]),
    echoSeenAt: new Map([[1, 120]]),
    maxTimerDriftMs: 0
  })
  for (const statusTrafficModel of [
    'electron-ipc-burst-through-production-bridge',
    null
  ] as const) {
    writeBenchReport(
      { annotations: [] },
      'workspace-updates',
      { measurement, appliedCpuThrottleRate: 1, inAppDiagnostic: null },
      { cpuWorkers: 0, ptyMetadata: false, statusTrafficModel },
      null,
      null
    )
    expect(JSON.parse(output.json).config).toMatchObject({
      cpuWorkers: 0,
      ptyMetadata: false,
      statusTrafficModel
    })
  }
})
