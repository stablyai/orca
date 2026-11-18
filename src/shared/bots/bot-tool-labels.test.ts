import { describe, expect, it } from 'vitest'
import { botToolSubtitle, botToolTitle } from './bot-tool-labels'

describe('bot tool labels', () => {
  it('titles a tool by its name and says where it comes from in a word', () => {
    expect(botToolTitle('globex-metrics')).toBe('Globex metrics')
    expect(botToolSubtitle({ detail: 'https://mcp.notion.com/mcp', remote: true })).toBe(
      'mcp.notion.com'
    )
    expect(botToolSubtitle({ detail: 'node ~/tools/metrics-mcp/index.js', remote: false })).toBe(
      'metrics-mcp'
    )
    expect(
      botToolSubtitle({ detail: 'npx -y @notionhq/notion-mcp-server@1.2', remote: false })
    ).toBe('notion-mcp-server')
  })
})
