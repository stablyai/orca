import { describe, expect, it } from 'vitest'
import { botToolDetail, botToolNameFrom, freeBotToolName } from './bot-tools'

describe('bot tool names', () => {
  it('names a tool by its host or package, without the words every server carries', () => {
    expect(botToolNameFrom('https://mcp.notion.com/mcp')).toBe('notion')
    expect(botToolNameFrom('https://mcp.linear.app/sse')).toBe('linear')
    expect(botToolNameFrom('npx -y @notionhq/notion-mcp-server')).toBe('notion')
    expect(botToolNameFrom('npx -y @sentry/mcp-server@0.4.1')).toBe('sentry')
    expect(botToolNameFrom('uvx mcp-server-time --local-timezone=UTC')).toBe('time')
    expect(botToolNameFrom('npx -y mcp-server')).toBe('tool')
  })

  it('shows a command server by its whole command line', () => {
    expect(botToolDetail({ name: 'time', command: 'uvx', args: ['mcp-server-time'] })).toBe(
      'uvx mcp-server-time'
    )
  })

  it('suggests the first free numbered name for a taken one', () => {
    expect(freeBotToolName('notion', new Set())).toBe('notion')
    expect(freeBotToolName('notion', new Set(['notion', 'notion-2']))).toBe('notion-3')
  })
})
