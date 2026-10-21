import { describe, expect, it } from 'vitest'
import {
  formatToolDuration,
  MAX_TOOL_SEARCH_RESULTS,
  mcpToolIdentity,
  toolExecutionMetadata,
  toolWebSearchResults
} from './native-chat-tool-identity'

describe('MCP tool identity', () => {
  it.each(['mcp__linear__list_issues'])(
    'splits %s for display without changing the identifier',
    (name) => {
      const raw = name
      expect(mcpToolIdentity(name)).toEqual({ server: 'Linear', tool: 'list issues' })
      expect(name).toBe(raw)
    }
  )
  it.each([
    'linear/list_issues',
    'linear.list_issues',
    'tools/read',
    'docs/search',
    'browser.open',
    'archive.tar',
    'package.lock',
    'setup.py',
    'src/read',
    'src/tool.ts',
    '/usr/bin/tool',
    './server/tool',
    'read',
    'search',
    'list',
    'mcp__',
    'mcp____tool',
    'server/',
    'server.',
    'run_mcp__thing'
  ])('does not claim an MCP identity for %s', (name) => expect(mcpToolIdentity(name)).toBeNull())
  it('uses explicit provider identity without changing the raw name', () => {
    const identity = Object.freeze({ server: 'my_server', tool: 'ns.tool' })
    expect(mcpToolIdentity('my_server/ns.tool', identity)).toEqual({
      server: 'My server',
      tool: 'ns.tool'
    })
  })
  it('keeps an explicitly qualified tool even when its name resembles a file extension', () => {
    expect(mcpToolIdentity('mcp__server__py')).toEqual({ server: 'Server', tool: 'py' })
  })
})

describe('command metadata', () => {
  it.each([
    [0, '0ms'],
    [400, '400ms'],
    [1000, '1s'],
    [62000, '1m 2s'],
    [3600000, '1h 0m 0s']
  ])('formats %s milliseconds as %s', (value, expected) =>
    expect(formatToolDuration(value)).toBe(expected)
  )
  it.each([undefined, null, '400', -1, Number.NaN, Infinity])(
    'omits invalid duration %s',
    (value) => {
      expect(formatToolDuration(value)).toBeNull()
      expect(toolExecutionMetadata({ exitCode: value, durationMs: value })).toEqual(
        value === -1 ? { exitCode: -1 } : {}
      )
    }
  )
  it('accepts both provider casings and keeps zero values', () => {
    expect(toolExecutionMetadata({ exitCode: 0, durationMs: 0 })).toEqual({
      exitCode: 0,
      durationMs: 0
    })
    expect(toolExecutionMetadata({ exitCode: 127, duration_ms: 400 })).toEqual({
      exitCode: 127,
      durationMs: 400
    })
    expect(toolExecutionMetadata({ exitCode: 1.5 })).toEqual({})
  })
})

describe('web search results', () => {
  it('keeps safe results, removes duplicate URLs, and falls back to URL when title is absent', () => {
    expect(
      toolWebSearchResults([
        { title: ' Docs ', url: ' https://example.com ' },
        { title: 'Duplicate', url: 'https://example.com/' },
        { url: 'http://example.org/page' },
        { title: 'Unsafe', url: 'javascript:alert(1)' },
        { url: 'file:///tmp/a' },
        { url: 'https://user:pass@example.com/' },
        { url: 'https://' },
        null,
        {},
        4
      ])
    ).toEqual([
      { title: 'Docs', url: 'https://example.com' },
      { title: 'http://example.org/page', url: 'http://example.org/page' }
    ])
  })
  it('bounds result count and title size without truncating link destinations', () => {
    const results = toolWebSearchResults(
      Array.from({ length: 20 }, (_, i) => ({
        title: 'x'.repeat(500),
        url: `https://example.com/${i}`
      }))
    )
    expect(results).toHaveLength(MAX_TOOL_SEARCH_RESULTS)
    expect(results[0]!.title).toHaveLength(200)
    expect(toolWebSearchResults([{ url: `https://example.com/${'x'.repeat(3000)}` }])).toEqual([])
  })
  it.each([null, undefined, {}, '[]'])('ignores malformed collection %s', (value) => {
    expect(toolWebSearchResults(value)).toEqual([])
  })
})
