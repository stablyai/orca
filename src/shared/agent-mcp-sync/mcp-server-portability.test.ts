import { describe, expect, it } from 'vitest'
import { isLocalOnlyPath, portMcpServer } from './mcp-server-portability'

const HOME = '/Users/me'

describe('portMcpServer', () => {
  it('sends remote servers whole but shows only the origin', () => {
    const ported = portMcpServer(
      'claude',
      { type: 'http', url: 'https://mcp.example.com/mcp?key=secret', headers: { a: 'b' } },
      HOME
    )
    expect(ported).toMatchObject({ ok: true, transport: 'http', target: 'https://mcp.example.com' })
    expect(ported.ok && ported.config.url).toBe('https://mcp.example.com/mcp?key=secret')
  })

  it('maps Claude transport names and treats a Codex url as http', () => {
    expect(
      portMcpServer('claude', { type: 'sse', url: 'https://a.example.com' }, HOME).transport
    ).toBe('sse')
    expect(
      portMcpServer('claude', { type: 'streamable-http', url: 'https://a.example.com' }, HOME)
        .transport
    ).toBe('http')
    expect(portMcpServer('codex', { url: 'https://a.example.com' }, HOME).transport).toBe('http')
  })

  it('keeps servers on this computer’s loopback here', () => {
    expect(
      portMcpServer('claude', { type: 'http', url: 'http://localhost:3845' }, HOME)
    ).toMatchObject({ ok: false, reason: 'local-url' })
    expect(portMcpServer('codex', { url: 'http://127.0.0.1:9000/mcp' }, HOME)).toMatchObject({
      ok: false,
      reason: 'local-url'
    })
  })

  it('skips a headers helper that only exists on this computer', () => {
    expect(
      portMcpServer(
        'claude',
        { type: 'http', url: 'https://a.example.com', headersHelper: '/Users/me/bin/token.sh' },
        HOME
      )
    ).toMatchObject({ ok: false, reason: 'local-command' })
  })

  it('rewrites absolute launcher paths to the bare name', () => {
    const ported = portMcpServer(
      'codex',
      { command: '/opt/homebrew/bin/npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      HOME
    )
    expect(ported).toMatchObject({ ok: true, target: 'npx' })
    expect(ported.ok && ported.config.command).toBe('npx')
  })

  it('skips commands and paths that only exist here', () => {
    expect(
      portMcpServer('claude', { command: '/Applications/Figma.app/Contents/mcp' }, HOME)
    ).toMatchObject({ ok: false, reason: 'local-command' })
    expect(
      portMcpServer('claude', { command: 'node', args: ['/Users/me/tools/server.js'] }, HOME)
    ).toMatchObject({ ok: false, reason: 'local-path' })
    expect(
      portMcpServer(
        'claude',
        { command: 'npx', env: { CONFIG: '--config=/Users/me/x.json' } },
        HOME
      )
    ).toMatchObject({ ok: false, reason: 'local-path' })
  })

  it('rejects entries that are not servers', () => {
    for (const entry of [null, 'npx', { args: [] }, { command: '  ' }, { url: 'ftp://x' }]) {
      expect(portMcpServer('claude', entry, HOME).ok).toBe(false)
    }
  })
})

describe('isLocalOnlyPath', () => {
  it('flags this user’s home only on a path boundary', () => {
    expect(isLocalOnlyPath('/Users/me', HOME)).toBe(true)
    expect(isLocalOnlyPath('/home/me/x', '/home/me')).toBe(true)
    expect(isLocalOnlyPath('/home/meadow/x', '/home/me')).toBe(false)
    expect(isLocalOnlyPath('C:\\tools\\x.exe', null)).toBe(true)
    expect(isLocalOnlyPath('@modelcontextprotocol/server-memory', HOME)).toBe(false)
  })
})
