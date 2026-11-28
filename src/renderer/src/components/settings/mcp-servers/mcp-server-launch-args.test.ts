import { describe, expect, it } from 'vitest'
import { formatMcpLaunchArgs, parseMcpLaunchArgs } from './mcp-server-launch-args'

// The one-line field must hand back the exact argv it shows, or a save silently changes the server.
describe('MCP server arguments line', () => {
  const argvs = [
    ['-y', '@modelcontextprotocol/server-postgres'],
    ['--root', '/Users/me/My Projects', "it's", ''],
    ['--flag=a b', '$HOME', 'a"b']
  ]

  it.each(argvs)('reads back what it writes on POSIX hosts: %j', (...args) => {
    const line = formatMcpLaunchArgs(args, 'darwin')
    expect(line).not.toBeNull()
    expect(parseMcpLaunchArgs(line!, 'darwin')).toEqual(args)
  })

  it('keeps Windows paths as typed', () => {
    const args = ['C:\\Program Files\\server\\index.js', '--port', '8080']
    const line = formatMcpLaunchArgs(args, 'win32')
    expect(line).toBe('"C:\\Program Files\\server\\index.js" --port 8080')
    expect(parseMcpLaunchArgs(line!, 'win32')).toEqual(args)
  })

  it('quotes Windows arguments that hold shell operators', () => {
    const args = ['https://example.test/mcp?a=1&b=2', '--name', 'a|b']
    expect(parseMcpLaunchArgs(formatMcpLaunchArgs(args, 'win32')!, 'win32')).toEqual(args)
  })

  it('gives no line for arguments it cannot write so they read back', () => {
    expect(formatMcpLaunchArgs(['say "hi" there'], 'win32')).toBeNull()
    expect(formatMcpLaunchArgs(['$(x)'], 'win32')).toBeNull()
    expect(formatMcpLaunchArgs(['line1\nline2'], 'linux')).toBeNull()
  })

  // Quote parsing is the shared tokenizer's; this line's own rule is refusing what a shell would run.
  it('refuses shell operators', () => {
    expect(parseMcpLaunchArgs('-y pkg && rm -rf /', 'linux')).toBeNull()
  })
})
