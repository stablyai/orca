import { describe, expect, it } from 'vitest'
import { applyMcpSyncResult, planMcpSync, type LocalMcpServer } from './mcp-sync-plan'

const HOME = '/Users/me'

function plan(servers: LocalMcpServer[], excluded: string[] = [], repo: string[] = []) {
  return planMcpSync({
    servers,
    excluded: new Set(excluded),
    repoServerNames: new Set(repo),
    homeDir: HOME
  })
}

describe('planMcpSync', () => {
  it('sends remote servers as-is and never exposes secrets in rows', () => {
    const result = plan([
      {
        agent: 'claude',
        name: 'linear',
        source: 'claude-user',
        config: {
          type: 'http',
          url: 'https://user:pw@mcp.linear.app/mcp?key=sk-123',
          headers: { Authorization: 'Bearer abc' }
        }
      }
    ])
    expect(result.params.claude).toEqual({
      linear: {
        type: 'http',
        url: 'https://user:pw@mcp.linear.app/mcp?key=sk-123',
        headers: { Authorization: 'Bearer abc' }
      }
    })
    expect(result.rows).toEqual([
      {
        key: 'claude:linear',
        agent: 'claude',
        name: 'linear',
        source: 'claude-user',
        transport: 'http',
        target: 'https://mcp.linear.app',
        included: true,
        state: 'pending'
      }
    ])
    expect(JSON.stringify(result.rows)).not.toMatch(/sk-123|abc|pw/)
  })

  it('rewrites absolute launcher paths and skips commands that only exist here', () => {
    const result = plan([
      {
        agent: 'codex',
        name: 'fs',
        source: 'codex',
        config: { command: '/opt/homebrew/bin/npx', args: ['-y', 'server-fs', '/tmp'] }
      },
      {
        agent: 'codex',
        name: 'figma',
        source: 'codex',
        config: { command: '/Applications/Figma.app/Contents/MacOS/figma-mcp' }
      },
      {
        agent: 'claude',
        name: 'notes',
        source: 'claude-user',
        config: { command: 'node', args: ['/Users/me/mcp/notes.js'] }
      },
      {
        agent: 'claude',
        name: 'dev',
        source: 'claude-user',
        config: { type: 'http', url: 'http://localhost:3845/mcp' }
      }
    ])
    expect(result.params).toEqual({
      claude: {},
      codex: { fs: { command: 'npx', args: ['-y', 'server-fs', '/tmp'] } }
    })
    expect(result.rows.map((row) => [row.key, row.state, row.skipReason, row.target])).toEqual([
      ['claude:dev', 'skipped', 'local-url', 'http://localhost:3845'],
      ['claude:notes', 'skipped', 'local-path', 'node'],
      ['codex:figma', 'skipped', 'local-command', 'figma-mcp'],
      ['codex:fs', 'pending', undefined, 'npx']
    ])
  })

  it('honors per-server opt-out, defers to the repo .mcp.json and prefers project scope', () => {
    const result = plan(
      [
        { agent: 'claude', name: 'a', source: 'claude-user', config: { command: 'npx' } },
        { agent: 'claude', name: 'a', source: 'claude-project', config: { command: 'uvx' } },
        { agent: 'claude', name: 'b', source: 'claude-user', config: { command: 'npx' } },
        { agent: 'claude', name: 'c', source: 'claude-user', config: { command: 'npx' } },
        { agent: 'codex', name: 'c', source: 'codex', config: { command: 'npx' } }
      ],
      ['claude:b'],
      ['c']
    )
    expect(result.params).toEqual({
      claude: {},
      claudeProject: { a: { command: 'uvx' } },
      codex: { c: { command: 'npx' } }
    })
    expect(result.rows.map((row) => [row.key, row.source, row.skipReason])).toEqual([
      ['claude:a', 'claude-project', undefined],
      ['claude:b', 'claude-user', 'turned-off'],
      ['claude:c', 'claude-user', 'in-repo'],
      ['codex:c', 'codex', undefined]
    ])
  })
})

describe('applyMcpSyncResult', () => {
  it('marks host outcomes and unreachable remote hosts', () => {
    const { rows } = plan([
      {
        agent: 'claude',
        name: 'linear',
        source: 'claude-user',
        config: { url: 'https://mcp.linear.app/mcp' }
      },
      { agent: 'claude', name: 'py', source: 'claude-user', config: { command: 'uvx' } },
      { agent: 'codex', name: 'mine', source: 'codex', config: { command: 'npx' } }
    ])
    const applied = applyMcpSyncResult(rows, {
      claude: { linear: 'added', py: 'command-missing' },
      codex: { mine: 'kept-host' },
      unreachableHosts: ['mcp.linear.app']
    })
    expect(applied.map((row) => [row.key, row.state, row.outcome, row.unreachable])).toEqual([
      ['claude:linear', 'synced', 'added', true],
      ['claude:py', 'skipped', 'command-missing', undefined],
      ['codex:mine', 'skipped', 'kept-host', undefined]
    ])
  })
})
