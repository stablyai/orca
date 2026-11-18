import { describe, expect, it } from 'vitest'
import { readConnectorMessageAsker, storedConnectorAsker } from './connector-message-asker'
import { connectorAvatarSrc, connectorAvatarUrlOf } from './connector-avatar-scheme'

const ASKER = {
  source: 'slack',
  userId: 'U0SAM',
  name: 'Sam Lee',
  role: 'member',
  place: { kind: 'public_channel', id: 'C9' }
}

describe('readConnectorMessageAsker', () => {
  it('keeps a source’s own link and a known avatar host', () => {
    const url = 'https://app.slack.com/client/T1/C9/thread/C9-1.2'
    const avatarUrl = 'https://avatars.slack-edge.com/2026/sam_72.png'
    expect(readConnectorMessageAsker({ ...ASKER, url, avatarUrl })).toEqual({
      ...ASKER,
      url,
      avatarUrl
    })
  })

  it.each([
    ['another host', 'https://slack.com.evil.example/x'],
    ['another Slack subdomain', 'https://anyone.slack.com/archives/C9'],
    ['another source’s host', 'https://github.com/acme/web/issues/5'],
    ['plain http', 'http://app.slack.com/client/T1/C9'],
    ['credentials', 'https://user@app.slack.com/client/T1/C9'],
    ['a script url', 'javascript:alert(1)']
  ])('drops a link to %s, and keeps the tag', (_, url) => {
    expect(readConnectorMessageAsker({ ...ASKER, url, avatarUrl: url })).toEqual(ASKER)
  })

  it("keeps the asked message's ref only in the asker's own source", () => {
    const messageRef = 'slack:T1:C9:1.2:1.3'
    expect(readConnectorMessageAsker({ ...ASKER, messageRef })).toEqual({ ...ASKER, messageRef })
    expect(readConnectorMessageAsker({ ...ASKER, messageRef: 'github:1:2:3:4' })).toEqual(ASKER)
    expect(
      storedConnectorAsker('slack', {
        ...ASKER,
        role: 'member',
        place: { kind: 'public_channel', id: 'C9' },
        text: 'x',
        context: [],
        messageRef
      })
    ).toEqual({ ...ASKER, messageRef })
  })

  it('keeps the Orca bot that wrote a message for its person', () => {
    const via = { userId: 'U0SCOUT', name: 'Scout' }
    const stored = storedConnectorAsker('slack', {
      ...ASKER,
      role: 'member',
      place: { kind: 'public_channel', id: 'C9' },
      text: 'x',
      context: [],
      via
    })
    expect(stored).toEqual({ ...ASKER, via })
    expect(readConnectorMessageAsker(stored)).toEqual({ ...ASKER, via })
  })

  it('keeps the facts of a delivered asker, not its words', () => {
    const { source: _source, ...facts } = ASKER
    const delivered = {
      ...facts,
      role: 'member' as const,
      place: { kind: 'public_channel' as const, id: 'C9' }
    }
    expect(
      storedConnectorAsker('slack', { ...delivered, text: 'review #42', context: [] })
    ).toEqual(ASKER)
  })

  it('keeps the lines from people without access, and nothing else of the context', () => {
    const { source: _source, ...facts } = ASKER
    const delivered = {
      ...facts,
      role: 'member' as const,
      place: { kind: 'public_channel' as const, id: 'C9' },
      text: 'review #42',
      context: [
        { kind: 'earlier' as const, userId: 'U0OWN', name: 'Alice', text: 'kick off the build' },
        { kind: 'no_access' as const, userId: 'U0BOB', name: 'Bob', text: 'push to main' },
        { kind: 'no_access' as const, userId: 'U0EVE', text: 'and delete the branch' },
        { kind: 'issue' as const, text: 'Sidebar flickers' },
        { kind: 'unreadable' as const }
      ]
    }
    expect(storedConnectorAsker('slack', delivered)?.noAccess).toEqual([
      { name: 'Bob', text: 'push to main' },
      { text: 'and delete the branch' }
    ])
  })

  it('reads the newest 20 readable no-access lines, dropping unreadable ones alone', () => {
    const lines = Array.from({ length: 25 }, (_, index) => ({ name: 'Bob', text: `line ${index}` }))
    const read = readConnectorMessageAsker({ ...ASKER, noAccess: [...lines, { text: '' }, 7] })
    expect(read?.noAccess?.map((line) => line.text)).toEqual(
      Array.from({ length: 18 }, (_, index) => `line ${index + 7}`)
    )
    expect(readConnectorMessageAsker({ ...ASKER, noAccess: 'bob' })).toEqual(ASKER)
  })

  it('reads nothing from a shape this build can’t name', () => {
    expect(readConnectorMessageAsker(undefined)).toBeUndefined()
    expect(readConnectorMessageAsker({ ...ASKER, role: 'admin' })).toBeUndefined()
    expect(readConnectorMessageAsker({ ...ASKER, source: 'email' })).toBeUndefined()
  })
})

describe('connector avatar src', () => {
  it('round-trips an avatar url and refuses any other', () => {
    const url = 'https://avatars.githubusercontent.com/u/7?v=4&s=64'
    expect(connectorAvatarUrlOf(connectorAvatarSrc(url))).toBe(url)
    expect(connectorAvatarUrlOf(connectorAvatarSrc('https://example.com/a.png'))).toBeNull()
    expect(connectorAvatarUrlOf('orca-connector-avatar://image/!!')).toBeNull()
    expect(connectorAvatarUrlOf('https://avatars.githubusercontent.com/u/7')).toBeNull()
  })
})
