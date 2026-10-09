import { describe, expect, it } from 'vitest'
import { agentSessionFailureSentence } from './agent-session-failure-words'

describe('agent-specific sign-in guidance', () => {
  it.each([
    ['Missing key', 'Missing key. Then send your message again.'],
    ['Missing key.', 'Missing key. Then send your message again.'],
    ['Missing key!', 'Missing key! Then send your message again.'],
    ['Missing key?', 'Missing key? Then send your message again.'],
    ['"Missing key."', '"Missing key." Then send your message again.'],
    ['(Missing key.)', '(Missing key.) Then send your message again.'],
    ["('Missing key!')", "('Missing key!') Then send your message again."],
    ['“Missing key?”', '“Missing key?” Then send your message again.'],
    ['Missing key。', 'Missing key。Then send your message again.'],
    ['Missing key！', 'Missing key！Then send your message again.'],
    ['Missing key？', 'Missing key？Then send your message again.']
  ])('separates guidance after the provider detail %j', (detail, tail) => {
    expect(
      agentSessionFailureSentence(
        { kind: 'notSignedIn', detail: { text: detail, audience: 'person' } },
        'rejection',
        { agentName: 'Pi' }
      )
    ).toBe(
      `Sign in to Pi by running \`pi\` and using \`/login\` on the computer running this chat. ${tail}`
    )
  })

  it('leaves an unpunctuated detail alone when no guidance follows it', () => {
    const fact = {
      kind: 'notSignedIn',
      detail: { text: 'No API key found for anthropic', audience: 'person' }
    } as const
    const row = agentSessionFailureSentence(fact, 'row', { agentName: 'Pi' })
    expect(row.endsWith(fact.detail.text)).toBe(true)
    expect(
      agentSessionFailureSentence(fact, 'rejection', { agentName: 'Pi', retryControl: true })
    ).toBe(row)
  })

  it.each([
    ['Claude', 'claude auth login'],
    ['Codex', 'codex login'],
    ['Grok', 'grok login'],
    ['OpenCode', 'opencode auth login'],
    ['Pi', 'pi'],
    ['OMP', 'Sign in to OMP.']
  ])(
    'names %s and its verified command without inventing account selection',
    (agentName, command) => {
      const fact = {
        kind: 'notSignedIn',
        detail: { text: 'No API key is configured.', audience: 'person' }
      } as const
      const row = agentSessionFailureSentence(fact, 'row', { agentName })
      const rejection = agentSessionFailureSentence(fact, 'rejection', { agentName })
      expect(row).toContain(command)
      expect(rejection).toContain(command)
      expect(row).toContain(fact.detail.text)
      expect(rejection).toContain(fact.detail.text)
      expect(row).not.toContain('send your message again')
      expect(row).not.toContain('selected account')
      if (agentName === 'Pi') {
        expect(row).toContain('`/login`')
      }
    }
  )
  it.each([
    'The configured provider has no API key.',
    'provider_auth_failed: missing credentials',
    'HTTP 401 Unauthorized'
  ])('withholds internal or technical detail %j but keeps the sign-in step', (text) => {
    const fact = { kind: 'notSignedIn', detail: { text, audience: 'person' } } as const
    for (const surface of ['row', 'rejection'] as const) {
      const sentence = agentSessionFailureSentence(fact, surface, { agentName: 'Codex' })
      expect(sentence).toContain('codex login')
      expect(sentence).not.toContain(text)
      expect(sentence).not.toMatch(/provider/i)
    }
  })

  it('keeps diagnostic text literal and keeps log-only detail off the visible sentence', () => {
    const detail = 'No API key found for {{agent}} $t(fake.key)'
    expect(
      agentSessionFailureSentence(
        { kind: 'notSignedIn', detail: { text: detail, audience: 'person' } },
        'rejection',
        { agentName: 'Pi' }
      )
    ).toContain(detail)
    expect(
      agentSessionFailureSentence(
        { kind: 'notSignedIn', detail: { text: detail, audience: 'log' } },
        'row',
        { agentName: 'Pi' }
      )
    ).not.toContain(detail)
  })
  it('keeps command retry and managed-account advice', () => {
    expect(
      agentSessionFailureSentence({ kind: 'notSignedIn', account: 'managed' }, 'row', {
        agentName: 'Claude'
      })
    ).toBe("This Claude account isn't signed in. Sign in again in Claude Accounts settings.")
    expect(
      agentSessionFailureSentence({ kind: 'notSignedIn', account: 'managed' }, 'rejection', {
        agentName: 'Codex',
        command: 'clear'
      })
    ).toBe(
      "This Codex account isn't signed in. Sign in again in Codex Accounts settings. Run /clear again."
    )
  })
})
