import { describe, expect, it } from 'vitest'
import { parseBotToolPaste } from './bot-tool-paste'

describe('bot tool paste data', () => {
  it('extracts leading assignments and preserves exact argv, including empty and spaced values', () => {
    expect(
      parseBotToolPaste('TOKEN="a b" npx -y server "two words" "" " edge "', 'darwin')
    ).toMatchObject({
      command: 'npx',
      args: ['-y', 'server', 'two words', '', ' edge '],
      env: { TOKEN: 'a b' }
    })
  })
  it('preserves Windows executable paths on the execution target', () => {
    expect(
      parseBotToolPaste('"C:\\Program Files\\node.exe" "C:\\tools\\mcp.js" "two words"', 'win32')
    ).toMatchObject({
      command: 'C:\\Program Files\\node.exe',
      args: ['C:\\tools\\mcp.js', 'two words']
    })
  })
  it('uses execution-host environment key rules for pasted assignments too', () => {
    const source = 'TOKEN=one token=two node server.js'
    expect(() => parseBotToolPaste(source, 'win32')).toThrow('unique')
    expect(parseBotToolPaste(source, 'linux')).toMatchObject({
      env: { TOKEN: 'one', token: 'two' }
    })
  })
  it.each([
    'npx "unclosed',
    'npx server && echo bad',
    'npx $(whoami)',
    'npx server\nnext',
    'TOKEN=x',
    'ftp://example.com/mcp',
    'https://u:pw@example.com/mcp',
    'https:/broken',
    '{"mcpServers":{}}'
  ])('refuses malformed or shell paste without echoing it: %s', (value) => {
    expect(() => parseBotToolPaste(value, 'linux')).toThrow()
  })
})
