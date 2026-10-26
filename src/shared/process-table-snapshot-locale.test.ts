import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  getCheapProcessTableSnapshot,
  resetCheapProcessTableSnapshotForTests
} from './cheap-process-table-snapshot-reader'
import {
  getStrictProcessTableSnapshot,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'

afterEach(() => {
  vi.unstubAllEnvs()
  resetProcessTableSnapshotForTests()
  resetCheapProcessTableSnapshotForTests()
})

it.runIf(process.platform === 'darwin').each(['de_DE.UTF-8', 'C'])(
  'reads real macOS ps rows under LC_ALL=%s',
  async (locale) => {
    vi.stubEnv('LC_ALL', locale)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'café-ü'])
    try {
      await once(child, 'spawn')
      const strict = (await getStrictProcessTableSnapshot()).find((row) => row.pid === child.pid)
      const cheap = (await getCheapProcessTableSnapshot()).find((row) => row.pid === child.pid)

      expect(strict?.command).toContain('café-ü')
      expect(Number.isFinite(Date.parse(strict?.startTime ?? ''))).toBe(true)
      expect(cheap?.startTime?.replace(/\s+/g, ' ')).toBe(strict?.startTime?.replace(/\s+/g, ' '))
    } finally {
      child.kill()
    }
  }
)
