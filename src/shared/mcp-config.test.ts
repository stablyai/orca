import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canInspectLocalMcpConfigRoot,
  getMcpConfigCandidateParentDir,
  getMcpConfigParentDirs,
  inspectMcpConfigContent,
  maskMcpEnv,
  MCP_CONFIG_CANDIDATES,
  MCP_STARTER_CONFIG,
  selectExistingMcpConfigCandidates
} from './mcp-config'
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

  it('reports missing configs', () => {
    expect(inspectMcpConfigContent(workspaceCandidate, null)).toMatchObject({
      exists: false,
      status: 'missing',
      servers: []
    })
  })

  it('reports invalid JSON without exposing file contents', () => {
    const result = inspectMcpConfigContent(workspaceCandidate, '{')
    expect(result.status).toBe('invalid')
    expect(result.error).toContain('JSON')
    expect(result.servers).toEqual([])
  })

  it('summarizes stdio, http, disabled, and invalid servers', () => {
    const result = inspectMcpConfigContent(
      workspaceCandidate,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: { NODE_ENV: 'production', API_TOKEN: 'secret-token' }
          },
          docs: { type: 'http', url: 'https://example.com/mcp' },
          old: { command: 'node', enabled: false },
          broken: { args: ['missing-command'] }
        }
      })
    )

    expect(result.status).toBe('valid')
    expect(result.servers).toEqual([
      {
        name: 'filesystem',
        transport: 'stdio',
        status: 'enabled',
        command: 'npx',
        env: { NODE_ENV: 'production', API_TOKEN: '••••••••' }
      },
      {
        name: 'docs',
        transport: 'http',
        status: 'enabled',
        url: 'https://example.com/mcp'
      },
      {
        name: 'old',
        transport: 'stdio',
        status: 'disabled',
        command: 'node'
      },
      {
        name: 'broken',
        transport: 'unknown',
        status: 'invalid',
        issue: 'Missing command or URL.'
      }
    ])
  })

  it('supports agent-specific command and URL shapes from common adapters', () => {
    const result = inspectMcpConfigContent(
      workspaceCandidate,
      JSON.stringify({
        mcpServers: {
          opencodeLocal: { type: 'local', command: ['uvx', 'server'] },
          geminiRemote: { httpUrl: 'https://example.com/sse' }
        }
      })
    )

    expect(result.servers).toMatchObject([
      { name: 'opencodeLocal', transport: 'stdio', command: 'uvx' },
      { name: 'geminiRemote', transport: 'http', url: 'https://example.com/sse' }
    ])
  })

  it('marks declared transports without their target as invalid', () => {
    const result = inspectMcpConfigContent(
      workspaceCandidate,
      JSON.stringify({
        mcpServers: {
          remoteMissingUrl: { type: 'http' },
          localMissingCommand: { type: 'local' }
        }
      })
    )

    expect(result.servers).toEqual([
      {
        name: 'remoteMissingUrl',
        transport: 'http',
        status: 'invalid',
        issue: 'Missing URL.'
      },
      {
        name: 'localMissingCommand',
        transport: 'stdio',
        status: 'invalid',
        issue: 'Missing command.'
      }
    ])
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

  it('keeps starter config valid and empty', () => {
    expect(inspectMcpConfigContent(workspaceCandidate, MCP_STARTER_CONFIG)).toMatchObject({
      exists: true,
      status: 'valid',
      servers: []
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

  it('plans directory discovery before reading candidate files', () => {
    expect(getMcpConfigParentDirs()).toEqual(['.cursor', '.claude'])
    expect(
      MCP_CONFIG_CANDIDATES.map((candidate) => getMcpConfigCandidateParentDir(candidate))
    ).toEqual(['', '.cursor', '', '.claude'])

    const entriesByRelativeDir = new Map([
      [
        '',
        [
          { name: '.mcp.json', isDirectory: false },
          { name: '.cursor', isDirectory: true },
          { name: '.claude', isDirectory: false }
        ]
      ],
      ['.cursor', [{ name: 'mcp.json', isDirectory: false }]]
    ])

    expect(
      selectExistingMcpConfigCandidates(entriesByRelativeDir).map((entry) => entry.label)
    ).toEqual(['Workspace', 'Cursor'])
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
