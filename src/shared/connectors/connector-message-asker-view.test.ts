import { describe, expect, it } from 'vitest'
import type { ConnectorMessageAsker } from '../connector-message-asker'
import { connectorAskerTagView, connectorNoAccessView } from './connector-message-asker-view'

function t(_key: string, fallback: string, values: Record<string, unknown> = {}): string {
  return fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]))
}

const SAM: ConnectorMessageAsker = {
  source: 'slack',
  userId: 'U0SAM',
  name: 'Sam Lee',
  role: 'member',
  place: { kind: 'public_channel', id: 'C9' },
  url: 'https://app.slack.com/client/T1/C9/thread/C9-1.2'
}

describe('connectorAskerTagView', () => {
  it('reads "You" for the owner in a DM', () => {
    const view = connectorAskerTagView(
      { ...SAM, role: 'owner', place: { kind: 'direct_message', id: 'D1' } },
      t
    )
    expect(view).toMatchObject({ own: true, name: 'You', place: 'Slack DM' })
  })

  it('uses the issue id for an unnamed asker without a link', () => {
    const issue = connectorAskerTagView(
      {
        source: 'linear',
        userId: 'u1',
        role: 'member',
        place: { kind: 'issue', id: 'ENG-123' }
      },
      t
    )
    expect(issue).toMatchObject({ name: 'Someone', place: 'ENG-123', open: null })
  })
})

describe('connectorNoAccessView', () => {
  it('counts the lines and marks each, keeping repeated lines apart', () => {
    const view = connectorNoAccessView(
      {
        ...SAM,
        noAccess: [
          { name: 'Alex Kim', text: 'same' },
          { name: 'Alex Kim', text: 'same' },
          { text: 'Only on main.' }
        ]
      },
      t
    )
    expect(view?.toggle).toBe('3 earlier messages in the thread')
    expect(
      view?.lines.map(({ name, initials, title, text }) => [name, initials, title, text])
    ).toEqual([
      ['Alex Kim', 'AK', 'Alex Kim · Slack · no access', 'same'],
      ['Alex Kim', 'AK', 'Alex Kim · Slack · no access', 'same'],
      ['Someone', 'S', 'Someone · Slack · no access', 'Only on main.']
    ])
    expect(new Set(view?.lines.map((line) => line.key)).size).toBe(3)
  })
})
