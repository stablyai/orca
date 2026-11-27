import { describe, expect, it } from 'vitest'
import { discordBotToken } from './connector-bot-discord-contract'

// Made up, and built from parts so secret scanners don't read it as a leaked token.
const TOKEN = ['A'.repeat(24), 'B'.repeat(6), 'C'.repeat(38)].join('.')

describe('discordBotToken', () => {
  it('takes a token pasted with spaces, quotes or a Bot prefix', () => {
    expect(discordBotToken(` ${TOKEN}\n`)).toBe(TOKEN)
    expect(discordBotToken(`"${TOKEN}"`)).toBe(TOKEN)
    expect(discordBotToken(`Bot ${TOKEN}`)).toBe(TOKEN)
  })

  it('refuses what is not a bot token, such as a client secret or an application id', () => {
    expect(discordBotToken('k3J9_client-secret_value_32chars')).toBeNull()
    expect(discordBotToken('1098765432109876543')).toBeNull()
    expect(discordBotToken('')).toBeNull()
  })
})
