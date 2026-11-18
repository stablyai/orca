import { describe, expect, it } from 'vitest'
import { botConnectorTitles, type BotConnectorTitleParts } from './bot-connector-titles'

function texts(rows: BotConnectorTitleParts[]): string[] {
  const titles = botConnectorTitles(rows)
  return rows.map((row) => {
    const title = titles.get(row.key)
    return title?.name ? `${title.service} · ${title.name}` : (title?.service ?? '')
  })
}

const VIA = 'via Composio'

describe('botConnectorTitles', () => {
  it('marks the Composio row beside a native one of the same service', () => {
    expect(
      texts([
        { key: 'github:1', service: 'GitHub', place: 'stablyai' },
        { key: 'composio:c1', service: 'GitHub', hints: [VIA, 'Alice-H'] }
      ])
    ).toEqual(['GitHub · stablyai', 'GitHub · via Composio'])
  })

  it('names the account when two Composio rows share an app', () => {
    expect(
      texts([
        { key: 'slack:T1', service: 'Slack', place: 'Globex' },
        { key: 'composio:c1', service: 'Slack', hints: [VIA, 'a@example.com'] },
        { key: 'composio:c2', service: 'Slack', hints: [VIA, 'b@example.com'] }
      ])
    ).toEqual(['Slack · Globex', 'Slack · a@example.com', 'Slack · b@example.com'])
  })

  it('tells same-named apps apart by their address, matching services case-insensitively', () => {
    expect(
      texts([
        { key: 'linear:w1', service: 'Linear', place: 'Acme' },
        { key: 'app:linear', service: 'linear', hints: ['mcp.linear.app'] }
      ])
    ).toEqual(['Linear · Acme', 'linear · mcp.linear.app'])
  })
})
