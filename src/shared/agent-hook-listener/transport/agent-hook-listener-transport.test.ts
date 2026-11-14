import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEndpointFileName, writeEndpointFile } from './endpoint-publication'

describe('shared agent-hook-listener', () => {
  describe('writeEndpointFile', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-hook-listener-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('refuses unsafe values', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'safe-token',
        env: 'foo&bar',
        version: '1'
      })
      expect(ok).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    })
  })
})
