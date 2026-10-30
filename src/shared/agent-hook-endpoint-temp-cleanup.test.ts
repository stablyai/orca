import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  enabled: false,
  closeSync: vi.fn(),
  readSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    opendirSync: (path: string, options: { bufferSize: number }) =>
      fsMocks.enabled
        ? { closeSync: fsMocks.closeSync, readSync: fsMocks.readSync }
        : actual.opendirSync(path, options),
    statSync: (path: string) => (fsMocks.enabled ? fsMocks.statSync(path) : actual.statSync(path)),
    unlinkSync: (path: string) =>
      fsMocks.enabled ? fsMocks.unlinkSync(path) : actual.unlinkSync(path)
  }
})

import {
  AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES,
  sweepStaleAgentHookEndpointTemps
} from './agent-hook-endpoint-temp-cleanup'

describe('agent hook endpoint temp cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fsMocks.enabled = false
    fsMocks.statSync.mockReturnValue({ mtimeMs: 0 })
  })

  it('stops an unbounded directory source at the scan cap', () => {
    fsMocks.enabled = true
    let entry = 0
    fsMocks.readSync.mockImplementation(() => ({
      name: `.endpoint-${(entry += 1)}.tmp`
    }))

    sweepStaleAgentHookEndpointTemps('/endpoint', 10 * 60 * 1000)

    expect(fsMocks.readSync).toHaveBeenCalledTimes(AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES)
    expect(fsMocks.unlinkSync).toHaveBeenCalledTimes(AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES)
    expect(fsMocks.closeSync).toHaveBeenCalledOnce()
  })

  it('counts skipped names against the scan cap', () => {
    fsMocks.enabled = true
    let scanned = 0
    fsMocks.readSync.mockImplementation(() =>
      ++scanned <= AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES + 2
        ? { name: `unrelated-${scanned}` }
        : null
    )
    sweepStaleAgentHookEndpointTemps('/endpoint', 10 * 60 * 1000)
    expect(fsMocks.readSync).toHaveBeenCalledTimes(AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES)
    expect(fsMocks.statSync).not.toHaveBeenCalled()
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled()
    expect(fsMocks.closeSync).toHaveBeenCalledOnce()
  })

  it('removes only matching temp files strictly older than five minutes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-hook-endpoint-sweep-'))
    try {
      const now = 1_000_000
      for (const [name, age] of [
        ['.endpoint-stale.tmp', 300_001],
        ['.endpoint-boundary.tmp', 300_000],
        ['.endpoint-fresh.tmp', 299_999],
        ['.endpoint-wrong-extension.txt', 900_000],
        ['wrong-prefix.tmp', 900_000],
        ['endpoint.env', 900_000]
      ] as const) {
        const path = join(directory, name)
        writeFileSync(path, 'endpoint fixture')
        utimesSync(path, (now - age) / 1000, (now - age) / 1000)
      }
      sweepStaleAgentHookEndpointTemps(directory, now)
      expect(readdirSync(directory).sort()).toEqual([
        '.endpoint-boundary.tmp',
        '.endpoint-fresh.tmp',
        '.endpoint-wrong-extension.txt',
        'endpoint.env',
        'wrong-prefix.tmp'
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
