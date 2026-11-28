import { describe, expect, it } from 'vitest'
import type { ConnectorAsker } from './connectors/connector-cloud-contract'
import { connectorAskerPrompt, connectorMessageShownText } from './connector-asker-prompt'

const asker = (overrides: Partial<ConnectorAsker> = {}): ConnectorAsker => ({
  userId: 'U1',
  name: 'Ada',
  role: 'owner',
  place: { kind: 'direct_message', id: 'D0DANA' },
  text: 'look at this\n[image: shot, file F123]',
  context: [],
  ...overrides
})

const DM_REF = 'slack:T0TEAM:D0DANA::1234567890.123456'

describe('connectorAskerPrompt file download hints', () => {
  it('gives a DM image a download command on the message ref', () => {
    const prompt = connectorAskerPrompt('slack', asker({ messageRef: DM_REF }))
    expect(prompt).toContain(`\`orca slack read ${DM_REF} --download F123\` saves it`)
    expect(connectorMessageShownText(prompt)).toBe('look at this\n[image: shot, file F123]')
  })

  it('gives each later queued message its own ref and files', () => {
    const prompt = connectorAskerPrompt('slack', asker(), undefined, {
      later: [
        {
          asker: asker({
            text: 'more\n[file: report, file F456]',
            messageRef: 'slack:T0TEAM:D0DANA::1234567890.123457'
          })
        }
      ]
    })
    expect(prompt).toContain(
      '`orca slack read slack:T0TEAM:D0DANA::1234567890.123457 --download F456` saves it'
    )
  })

  it('says a file is not shown rather than offering a person ref or no ref', () => {
    const notShown = "part of their request isn't shown here (a file in it)"
    for (const messageRef of [undefined, 'slack:T0TEAM:user:U123']) {
      const prompt = connectorAskerPrompt('slack', asker({ messageRef }))
      expect(prompt).toContain(notShown)
      expect(prompt).not.toContain('--download F123')
    }
  })

  it('keeps the channel thread ref working', () => {
    const ref = 'slack:T0TEAM:C0CHAN:1234567890.000001:1234567890.123456'
    expect(
      connectorAskerPrompt(
        'slack',
        asker({ place: { kind: 'public_channel', id: 'C0CHAN' }, messageRef: ref })
      )
    ).toContain(`\`orca slack read ${ref} --download F123\` saves it`)
  })
})
