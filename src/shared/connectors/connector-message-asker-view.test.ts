import { describe, expect, it } from 'vitest'
import type { ConnectorMessageAsker } from '../connector-message-asker'
import {
  connectorAskerInitials,
  connectorAskerTagView,
  connectorNoAccessView
} from './connector-message-asker-view'

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
  it('names a member and the channel source, with the link it opens', () => {
    expect(connectorAskerTagView(SAM, t)).toEqual({
      source: 'slack',
      own: false,
      name: 'Sam Lee',
      place: 'Slack',
      label: 'Sam Lee in Slack',
      open: { url: SAM.url, label: 'Open in Slack' }
    })
  })

  it('reads "You" for the owner in a DM', () => {
    const view = connectorAskerTagView(
      { ...SAM, role: 'owner', place: { kind: 'direct_message', id: 'D1' } },
      t
    )
    expect(view).toMatchObject({ own: true, name: 'You', place: 'Slack DM' })
  })

  it('names a group DM, an issue by its id, and an unnamed member as Someone, without a link', () => {
    expect(
      connectorAskerTagView({ ...SAM, place: { kind: 'group_message', id: 'G1' } }, t).place
    ).toBe('Slack group DM')
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
  it('is null without lines', () => {
    expect(connectorNoAccessView(SAM, t)).toBeNull()
  })

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

describe('connectorAskerInitials', () => {
  it('takes the first and last word, or the one name', () => {
    expect(connectorAskerInitials('Sam Lee')).toBe('SL')
    expect(connectorAskerInitials('Ana María de la Cruz')).toBe('AC')
    expect(connectorAskerInitials('octo-member')).toBe('O')
  })
})
