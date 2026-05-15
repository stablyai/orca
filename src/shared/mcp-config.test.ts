import { describe, expect, it } from 'vitest'
import {
  inspectMcpConfigContent,
  maskMcpEnv,
  MCP_CONFIG_CANDIDATES,
  MCP_STARTER_CONFIG
} from './mcp-config'

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
})
