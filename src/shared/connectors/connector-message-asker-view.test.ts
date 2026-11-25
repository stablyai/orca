import { describe, expect, it } from 'vitest'
import { connectorAskerHeader } from '../connector-asker-prompt'
import { ConnectorAsker } from '../connector-asker-contract'
import { readConnectorMessageAsker, storedConnectorAsker } from '../connector-message-asker'
import { BotMemberSchema } from '../bot-types'
import { connectorAskerTagView } from './connector-message-asker-view'

const t = (_key: string, fallback: string, values?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))

// A request another Slack app on Who can ask made, as the cloud delivers it.
const appAsker = ConnectorAsker.parse({
  userId: 'U0CIAPP',
  name: 'CI (bot)',
  role: 'member',
  place: { kind: 'public_channel', id: 'C0GENERAL' },
  text: 'the deploy failed',
  context: [],
  app: true
})

describe("another Slack app's request", () => {
  it('keeps that an app asked through the journal, and reads by its name', () => {
    const stored = storedConnectorAsker('slack', appAsker)
    expect(stored).toMatchObject({ userId: 'U0CIAPP', app: true })
    expect(readConnectorMessageAsker(stored)).toEqual(stored)
    expect(connectorAskerTagView(stored!, t)).toMatchObject({
      own: false,
      name: 'CI (bot)',
      label: 'CI (bot) in Slack'
    })
  })

  it('reads as an app, never Someone, when the cloud sent no name', () => {
    const { name: _name, ...unnamed } = appAsker
    expect(connectorAskerTagView(storedConnectorAsker('slack', unnamed)!, t).name).toBe('An app')
  })

  it('tells the agent an app asked, not a person', () => {
    expect(connectorAskerHeader('slack', appAsker)).toBe(
      '[Orca: Slack · <#C0GENERAL> (public channel) · from <@U0CIAPP|CI (bot)>, another app your owner lets ask you (not a person, not your owner)]'
    )
  })

  it('reads as a person’s from a cloud that sends no app mark, or one this build can’t read', () => {
    const { app: _app, ...person } = appAsker
    expect(storedConnectorAsker('slack', person)?.app).toBeUndefined()
    expect(ConnectorAsker.parse({ ...appAsker, app: 'robot' }).app).toBeUndefined()
  })
})

describe('an app on Who can ask', () => {
  it('is saved marked as one, and an unknown kind never voids the member', () => {
    expect(BotMemberSchema.parse({ id: 'U0CIAPP', name: 'CI (app)', kind: 'app' }).kind).toBe('app')
    expect(BotMemberSchema.parse({ id: 'U1', name: 'Dana', kind: 'group' })).toEqual({
      id: 'U1',
      name: 'Dana'
    })
  })
})
