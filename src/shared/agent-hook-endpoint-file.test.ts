import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAgentHookEndpointFile } from './agent-hook-endpoint-file'
import { getEndpointFileName, writeEndpointFile } from './agent-hook-listener/endpoint-publication'

const ENDPOINT_LINES = [
  'ORCA_AGENT_HOOK_PORT=12345',
  'ORCA_AGENT_HOOK_TOKEN=token-123',
  'ORCA_AGENT_HOOK_ENV=production',
  'ORCA_AGENT_HOOK_VERSION=1'
]
const REQUIRED_FIELDS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION'
]
const ENDPOINT = { port: '12345', token: 'token-123', env: 'production', version: '1' }

describe('agent hook endpoint files', () => {
  it('parses POSIX endpoint.env contents', () => {
    expect(
      parseAgentHookEndpointFile(
        [
          'ORCA_AGENT_HOOK_PORT=12345',
          'ORCA_AGENT_HOOK_TOKEN=token-123',
          'ORCA_AGENT_HOOK_ENV=production',
          'ORCA_AGENT_HOOK_VERSION=1'
        ].join('\n')
      )
    ).toEqual({
      port: '12345',
      token: 'token-123',
      env: 'production',
      version: '1'
    })
  })

  it('parses Windows endpoint.cmd contents', () => {
    expect(
      parseAgentHookEndpointFile(
        [
          'set ORCA_AGENT_HOOK_PORT=54321',
          'set ORCA_AGENT_HOOK_TOKEN=token-abc',
          'set ORCA_AGENT_HOOK_ENV=development',
          'set ORCA_AGENT_HOOK_VERSION=1'
        ].join('\r\n')
      )
    ).toEqual({
      port: '54321',
      token: 'token-abc',
      env: 'development',
      version: '1'
    })
  })

  it.each(REQUIRED_FIELDS)('rejects an independently missing %s', (field) => {
    expect(parseAgentHookEndpointFile(ENDPOINT_LINES.join('\n'))).toEqual(ENDPOINT)
    const missing = ENDPOINT_LINES.filter((line) => !line.startsWith(`${field}=`)).join('\n')
    expect(() => parseAgentHookEndpointFile(missing)).toThrow(
      'Agent hook endpoint file is missing required fields'
    )
  })

  it.each(REQUIRED_FIELDS)('rejects an independently empty %s', (field) => {
    expect(parseAgentHookEndpointFile(ENDPOINT_LINES.join('\n'))).toEqual(ENDPOINT)
    const empty = ENDPOINT_LINES.map((line) =>
      line.startsWith(`${field}=`) ? `${field}=` : line
    ).join('\n')
    expect(() => parseAgentHookEndpointFile(empty)).toThrow(
      'Agent hook endpoint file is missing required fields'
    )
  })

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
