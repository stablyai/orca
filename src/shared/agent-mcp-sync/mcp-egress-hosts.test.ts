import { describe, expect, it } from 'vitest'
import type { McpSyncServerRow } from './mcp-sync-contract'
import { mcpEgressHostsOf, mergeMcpEgressHosts, publicEgressHost } from './mcp-egress-hosts'

const row = (overrides: Partial<McpSyncServerRow>): McpSyncServerRow => ({
  key: 'claude:x',
  agent: 'claude',
  name: 'x',
  source: 'claude-user',
  transport: 'http',
  target: 'https://mcp.example.com',
  included: true,
  state: 'pending',
  ...overrides
})

describe('mcpEgressHostsOf', () => {
  it('collects public hosts of remote servers being sent, once each', () => {
    expect(
      mcpEgressHostsOf([
        row({ target: 'https://MCP.Linear.app' }),
        row({ agent: 'codex', target: 'https://mcp.linear.app' }),
        row({ transport: 'sse', target: 'https://sse.example.com:8443' }),
        row({ transport: 'stdio', target: 'npx' }),
        row({ state: 'skipped', skipReason: 'turned-off', target: 'https://off.example.com' }),
        row({ target: 'http://10.0.0.5:3000' }),
        row({ target: 'https://tools.corp' }),
        row({ target: 'not a url' })
      ])
    ).toEqual(['mcp.linear.app', 'sse.example.com'])
  })

  it('rejects anything the control plane would refuse', () => {
    expect(publicEgressHost('mcp.example.com.')).toBe('mcp.example.com')
    for (const bad of ['localhost', '127.0.0.1', '*.example.com', 'printer.local', 'x', '']) {
      expect(publicEgressHost(bad)).toBeNull()
    }
  })
})

describe('mergeMcpEgressHosts', () => {
  it('adds wanted hosts and keeps hosts other tools declared', () => {
    expect(
      mergeMcpEgressHosts({ current: ['other.example.com'], owned: [], wanted: ['mcp.a.com'] })
    ).toEqual({
      hosts: ['mcp.a.com', 'other.example.com'],
      owned: ['mcp.a.com'],
      dropped: []
    })
  })

  it('takes back only its own hosts when servers go away', () => {
    expect(
      mergeMcpEgressHosts({
        current: ['mcp.a.com', 'mcp.b.com', 'other.example.com'],
        owned: ['mcp.a.com', 'mcp.b.com'],
        wanted: ['mcp.b.com']
      })
    ).toEqual({ hosts: ['mcp.b.com', 'other.example.com'], owned: ['mcp.b.com'], dropped: [] })
  })

  it('never claims a host someone else declared, so it survives the server leaving', () => {
    const first = mergeMcpEgressHosts({
      current: ['shared.example.com'],
      owned: [],
      wanted: ['shared.example.com']
    })
    expect(first.owned).toEqual([])
    expect(
      mergeMcpEgressHosts({ current: first.hosts, owned: first.owned, wanted: [] }).hosts
    ).toEqual(['shared.example.com'])
  })

  it('fills only the room under the ceiling and reports the rest', () => {
    const merge = mergeMcpEgressHosts({
      current: ['keep.example.com'],
      owned: [],
      wanted: ['c.example.com', 'a.example.com', 'b.example.com'],
      max: 3
    })
    expect(merge.hosts).toEqual(['a.example.com', 'b.example.com', 'keep.example.com'])
    expect(merge.owned).toEqual(['a.example.com', 'b.example.com'])
    expect(merge.dropped).toEqual(['c.example.com'])
  })
})
