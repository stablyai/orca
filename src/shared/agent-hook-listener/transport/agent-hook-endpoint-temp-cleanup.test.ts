import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { sweepStaleAgentHookEndpointTemps } from './agent-hook-endpoint-temp-cleanup'

describe('agent hook endpoint temp cleanup', () => {
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
