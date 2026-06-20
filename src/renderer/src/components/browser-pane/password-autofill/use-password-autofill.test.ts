import { describe, expect, it } from 'vitest'
import { parsePasswordBridgeMessage } from './use-password-autofill'
import { BROWSER_PASSWORD_MESSAGE_PREFIX } from '../../../../../shared/browser-credential-types'

const TOKEN = 'tok_aaaaaaaaaaaaaaaa'

describe('parsePasswordBridgeMessage', () => {
  it('parses a detect event with the matching token', () => {
    const payload = {
      type: 'detect',
      origin: 'https://github.com',
      fields: [{ fieldId: 'pf-1', rect: { x: 1, y: 2, width: 3, height: 4 } }]
    }
    const msg = `${BROWSER_PASSWORD_MESSAGE_PREFIX}${TOKEN}:${JSON.stringify(payload)}`
    expect(parsePasswordBridgeMessage(msg, TOKEN)).toEqual(payload)
  })

  it('ignores messages with a different token', () => {
    const msg = `${BROWSER_PASSWORD_MESSAGE_PREFIX}other:${JSON.stringify({ type: 'detect', origin: 'x', fields: [] })}`
    expect(parsePasswordBridgeMessage(msg, TOKEN)).toBeNull()
  })

  it('ignores non-bridge messages', () => {
    expect(parsePasswordBridgeMessage('console log line', TOKEN)).toBeNull()
  })

  it('ignores malformed JSON payloads', () => {
    expect(
      parsePasswordBridgeMessage(`${BROWSER_PASSWORD_MESSAGE_PREFIX}${TOKEN}:{not json`, TOKEN)
    ).toBeNull()
  })
})
