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
  it('names the account when two Composio rows share an app', () => {
    expect(
      texts([
        { key: 'slack:T1', service: 'Slack', place: 'Globex' },
        { key: 'composio:c1', service: 'Slack', hints: [VIA, 'a@example.com'] },
        { key: 'composio:c2', service: 'Slack', hints: [VIA, 'b@example.com'] }
      ])
    ).toEqual(['Slack · Globex', 'Slack · a@example.com', 'Slack · b@example.com'])
  })
})
