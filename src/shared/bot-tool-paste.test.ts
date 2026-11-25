import { describe, expect, it } from 'vitest'
import { parseMcpServersPaste } from './bot-tool-paste'

const paste = (text: string) => parseMcpServersPaste(text, 'darwin')

describe('parseMcpServersPaste', () => {
  it('reads an mcpServers block with comments and trailing commas, skipping SSE', () => {
    expect(
      paste(`{
        // from the docs
        "mcpServers": {
          "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "t" } },
          "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "X-Team": "a" } },
          "old": { "type": "sse", "url": "https://example.com/sse" },
        },
      }`)
    ).toEqual([
      {
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 't' }
      },
      { name: 'linear', url: 'https://mcp.linear.app/mcp', headers: { 'X-Team': 'a' } }
    ])
  })

  it('reads a copied entry fragment and a bare entry', () => {
    expect(paste('"my.server": { "httpUrl": "https://mcp.example.com/mcp" }')).toEqual([
      { name: 'my-server', url: 'https://mcp.example.com/mcp' }
    ])
    expect(paste('{ "command": "uvx", "args": ["mcp-server-fetch"] }')).toEqual([
      { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] }
    ])
  })

  it('reads claude mcp add lines as Claude saves them', () => {
    expect(
      paste(
        [
          '$ claude mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: Bearer abc"',
          'claude mcp add -s user -e API_KEY=1 B=2 airtable -- npx -y airtable-mcp-server',
          'claude mcp add-json weather \'{"type":"stdio","command":"/bin/weather","args":["--x"]}\'',
          'claude mcp add fs \\',
          '  npx @modelcontextprotocol/server-filesystem /tmp'
        ].join('\n')
      )
    ).toEqual([
      {
        name: 'sentry',
        url: 'https://mcp.sentry.dev/mcp',
        headers: { Authorization: 'Bearer abc' }
      },
      {
        name: 'airtable',
        command: 'npx',
        args: ['-y', 'airtable-mcp-server'],
        env: { API_KEY: '1', B: '2' }
      },
      { name: 'weather', command: '/bin/weather', args: ['--x'] },
      { name: 'fs', command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/tmp'] }
    ])
  })

  it('reads codex mcp add lines', () => {
    expect(
      paste(
        'codex mcp add docs --env TOKEN=x -- uvx docs-mcp --port 1\ncodex mcp add ctx --url https://mcp.context7.com/mcp'
      )
    ).toEqual([
      { name: 'docs', command: 'uvx', args: ['docs-mcp', '--port', '1'], env: { TOKEN: 'x' } },
      { name: 'ctx', url: 'https://mcp.context7.com/mcp' }
    ])
  })

  it('keeps the plain URL and command forms', () => {
    expect(paste('https://mcp.linear.app/mcp\nFOO=1 npx -y @scope/server-postgres')).toEqual([
      { name: 'linear', url: 'https://mcp.linear.app/mcp' },
      {
        name: 'postgres',
        command: 'npx',
        args: ['-y', '@scope/server-postgres'],
        env: { FOO: '1' }
      }
    ])
  })

  it('reads a quoted Windows executable as a command, not JSON', () => {
    expect(parseMcpServersPaste('"C:\\Program Files\\mcp\\server.exe" --stdio', 'win32')).toEqual([
      { name: 'tool', command: 'C:\\Program Files\\mcp\\server.exe', args: ['--stdio'] }
    ])
  })

  it('refuses what Orca cannot carry instead of guessing', () => {
    expect(() => paste('claude mcp add --transport sse linear https://mcp.linear.app/sse')).toThrow(
      /SSE/
    )
    expect(() =>
      paste('codex mcp add gh --url https://x.dev/mcp --bearer-token-env-var T')
    ).toThrow(/SSE/)
    expect(() => paste('{"mcpServers": {"a": {"type": "sse", "url": "https://x.dev"}}}')).toThrow(
      /no server/
    )
    expect(() =>
      paste('{"mcpServers": {"gh": {"url": "https://x.dev/mcp", "headers": {"A": "Bearer ${T}"}}}}')
    ).toThrow(/no server/)
    expect(() =>
      paste('claude mcp add --client-id abc --transport http x https://x.dev/mcp')
    ).toThrow(/OAuth/)
    expect(() => paste('{"mcpServers": ')).toThrow(/doesn’t parse/)
    expect(() => paste('claude mcp add onlyname')).toThrow(/mcp add command/)
  })
})
