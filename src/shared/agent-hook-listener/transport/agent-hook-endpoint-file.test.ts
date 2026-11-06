import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAgentHookEndpointFile } from './agent-hook-endpoint-file'
import { getEndpointFileName, writeEndpointFile } from './endpoint-publication'
const ENDPOINT = { port: '12345', token: 'token-123', env: 'production', version: '1' }

describe('agent hook endpoint files', () => {
  it('parses the endpoint bytes published by the platform writer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-hook-endpoint-parser-'))
    try {
      const path = join(directory, getEndpointFileName())
      expect(
        writeEndpointFile(directory, path, {
          port: 12345,
          token: 'token-123',
          env: 'production',
          version: '1'
        })
      ).toBe(true)
      expect(parseAgentHookEndpointFile(readFileSync(path, 'utf8'))).toEqual(ENDPOINT)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
