import { describe, expect, it } from 'vitest'
import { BOT_MCP_APPS, botMcpAppSiteUrl } from './bot-mcp-apps'

const datadog = BOT_MCP_APPS.find((app) => app.id === 'datadog')!

describe('Datadog sites', () => {
  it.each([
    ['us1', 'https://mcp.datadoghq.com/v1/mcp'],
    ['us3', 'https://mcp.us3.datadoghq.com/v1/mcp'],
    ['us5', 'https://mcp.us5.datadoghq.com/v1/mcp'],
    ['eu1', 'https://mcp.datadoghq.eu/v1/mcp'],
    ['ap1', 'https://mcp.ap1.datadoghq.com/v1/mcp'],
    ['ap2', 'https://mcp.ap2.datadoghq.com/v1/mcp']
  ])('connects %s to %s', (site, url) => {
    expect(botMcpAppSiteUrl(datadog, site)).toBe(url)
  })

  it('keeps US1 as the default', () => {
    expect(datadog.url).toBe('https://mcp.datadoghq.com/v1/mcp')
  })
})
