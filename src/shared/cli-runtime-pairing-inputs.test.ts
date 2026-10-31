import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installedCliRuntimeDirectory } from './cli-runtime-pairing-inputs'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})

const actual = await vi.importActual<typeof fs>('node:fs/promises')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cli-runtime-close-'))
  writeFileSync(join(root, 'node'), '', { mode: 0o755 })
  vi.mocked(fs.open).mockClear()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('installed CLI advisory cleanup', () => {
  it.each(['native', 'script', 'unknown', 'read failure'] as const)(
    'awaits one real close and preserves the %s result when cleanup rejects',
    async (kind) => {
      const command = join(root, 'agent')
      writeFileSync(
        command,
        kind === 'native'
          ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
          : kind === 'script'
            ? '#!/usr/bin/env node\n'
            : 'unknown'
      )
      const file = await actual.open(command, 'r')
      vi.mocked(fs.open).mockResolvedValueOnce(file)
      if (kind === 'read failure') {
        vi.spyOn(file, 'read').mockRejectedValueOnce(new Error('advisory read failed'))
      }
      let released!: () => void
      const closed = new Promise<void>((resolve) => {
        released = resolve
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const realClose = file.close.bind(file)
      const close = vi.spyOn(file, 'close').mockImplementationOnce(async () => {
        await realClose()
        released()
        await gate
        throw new Error('advisory close failed after release')
      })
      let settled = false
      const result = installedCliRuntimeDirectory(command, () => true).then(
        (value) => {
          settled = true
          return { value }
        },
        (error: unknown) => {
          settled = true
          return { error }
        }
      )
      try {
        await closed
        expect(file.fd).toBe(-1)
        expect(settled).toBe(false)
        expect(close).toHaveBeenCalledTimes(1)
      } finally {
        release()
      }
      expect(await result).toEqual({ value: kind === 'native' ? null : root })
      expect(close).toHaveBeenCalledTimes(1)
      expect(fs.open).toHaveBeenCalledExactlyOnceWith(command, expect.any(Number))
    }
  )
})
