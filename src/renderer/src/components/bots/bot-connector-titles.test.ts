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
  it('names the place a row is bound to, alone or not', () => {
    expect(
      texts([
        { key: 'github:1', service: 'GitHub', place: 'Alice-H' },
        { key: 'github:2', service: 'GitHub', place: 'stablyai' },
        { key: 'slack:T1', service: 'Slack', place: 'Globex' },
        { key: 'linear:w1', service: 'Linear', place: 'Acme' }
      ])
    ).toEqual(['GitHub · Alice-H', 'GitHub · stablyai', 'Slack · Globex', 'Linear · Acme'])
  })

  it('keeps the plain service for a row with no place, or one not yet named', () => {
    expect(
      texts([
        { key: 'github', service: 'GitHub' },
        { key: 'slack:T1', service: 'Slack', place: null },
        { key: 'google', service: 'Google', hints: ['me@example.com'] },
        { key: 'composio:c1', service: 'Notion', hints: [VIA, 'me@example.com'] },
        { key: 'app:docs', service: 'Docs', hints: ['docs.example.com'] },
        { key: 'webhooks', service: 'Webhooks' }
      ])
    ).toEqual(['GitHub', 'Slack', 'Google', 'Notion', 'Docs', 'Webhooks'])
  })

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

  it('names the Google accounts when another row is also Google', () => {
    expect(
      texts([
        { key: 'google', service: 'Google', hints: ['me@example.com'] },
        { key: 'composio:c1', service: 'Google', hints: [VIA, null] }
      ])
    ).toEqual(['Google · me@example.com', 'Google · via Composio'])
  })
})
