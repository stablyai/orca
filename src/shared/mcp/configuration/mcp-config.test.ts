import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canInspectLocalMcpConfigRoot,
  inspectMcpConfigContent,
  MCP_CONFIG_CANDIDATES
} from './mcp-config'
import { maskMcpEnv } from './mcp-server-inspection'
import {
  MCP_CONFIG_INSPECTION_MAX_BYTES,
  MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS,
  MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES,
  MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS,
  MCP_CONFIG_INSPECTION_MAX_SERVERS
} from './mcp-config-inspection-limits'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mcp-config', () => {
  const workspaceCandidate = MCP_CONFIG_CANDIDATES[0]

  it('reports invalid JSON without exposing file contents', () => {
    const result = inspectMcpConfigContent(workspaceCandidate, '{"API_TOKEN":"secret-token",}')
    expect(result.status).toBe('invalid')
    expect(result.error).toContain('JSON')
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(result.servers).toEqual([])
  })

  it('masks env values that look sensitive by key or value', () => {
    expect(
      maskMcpEnv({
        NORMAL: 'visible',
        PASSWORD: 'hunter2',
        MAYBE: 'sk-abc123456789xyz'
      })
    ).toEqual({
      NORMAL: 'visible',
      PASSWORD: '••••••••',
      MAYBE: '••••••••'
    })
  })

  it('parses the exact input boundary and rejects +1 before JSON parsing', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const exact = `${' '.repeat(MCP_CONFIG_INSPECTION_MAX_BYTES - 2)}{}`

    expect(inspectMcpConfigContent(workspaceCandidate, exact).status).toBe('valid')
    expect(parse).toHaveBeenCalledOnce()

    parse.mockClear()
    expect(inspectMcpConfigContent(workspaceCandidate, `${exact} `).status).toBe('invalid')
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('rejects multibyte input over the byte cap before JSON parsing', () => {
    const parse = vi.spyOn(JSON, 'parse')

    expect(
      inspectMcpConfigContent(
        workspaceCandidate,
        'é'.repeat(MCP_CONFIG_INSPECTION_MAX_BYTES / 2 + 1)
      ).status
    ).toBe('invalid')
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('admits the exact server cardinality and rejects +1', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MCP_CONFIG_INSPECTION_MAX_SERVERS }, (_, index) => [
        `server-${index}`,
        { command: 'node' }
      ])
    )

    expect(
      inspectMcpConfigContent(workspaceCandidate, JSON.stringify({ mcpServers: servers })).servers
    ).toHaveLength(MCP_CONFIG_INSPECTION_MAX_SERVERS)
    servers.overflow = { command: 'node' }
    expect(
      inspectMcpConfigContent(workspaceCandidate, JSON.stringify({ mcpServers: servers }))
    ).toMatchObject({ status: 'invalid', servers: [] })
  })

  it('admits an exact-size command and rejects the field at +1', () => {
    const exact = 'x'.repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS)
    const exactUtf8 = 'é'.repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES / 2)
    const inspectCommand = (command: string) =>
      inspectMcpConfigContent(
        workspaceCandidate,
        JSON.stringify({ mcpServers: { bounded: { command } } })
      ).servers[0]

    expect(inspectCommand(exact)).toMatchObject({ status: 'enabled', command: exact })
    expect(inspectCommand(`${exact}x`)).toMatchObject({
      status: 'invalid',
      issue: 'Command exceeds the MCP inspection field limit.'
    })
    expect(inspectCommand(exactUtf8)).toMatchObject({ status: 'enabled', command: exactUtf8 })
    expect(inspectCommand(`${exactUtf8}é`)).toMatchObject({
      status: 'invalid',
      issue: 'Command exceeds the MCP inspection field limit.'
    })
  })

  it('admits the exact env cardinality and rejects +1 without retaining env values', () => {
    const env = Object.fromEntries(
      Array.from({ length: MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS }, (_, index) => [
        `KEY_${index}`,
        'value'
      ])
    )
    const inspectEnv = () =>
      inspectMcpConfigContent(
        workspaceCandidate,
        JSON.stringify({ mcpServers: { bounded: { command: 'node', env } } })
      ).servers[0]

    expect(Object.keys(inspectEnv()?.env ?? {})).toHaveLength(MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS)
    env.OVERFLOW = 'value'
    expect(inspectEnv()).toMatchObject({
      status: 'invalid',
      issue: 'Environment exceeds the MCP inspection field limits.'
    })
    expect(inspectEnv()?.env).toBeUndefined()
  })

  it('rejects Windows-only local roots on non-Windows hosts', () => {
    expect(canInspectLocalMcpConfigRoot('C:\\repo', false)).toBe(false)
    expect(canInspectLocalMcpConfigRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', false)).toBe(
      false
    )
    expect(canInspectLocalMcpConfigRoot('//wsl.localhost/Ubuntu/home/me/repo', false)).toBe(false)
    expect(canInspectLocalMcpConfigRoot('/Users/me/repo', false)).toBe(true)
    expect(canInspectLocalMcpConfigRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', true)).toBe(
      true
    )
    expect(canInspectLocalMcpConfigRoot('//wsl.localhost/Ubuntu/home/me/repo', true)).toBe(true)
  })
})
