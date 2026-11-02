import { describe, expect, it } from 'vitest'
import {
  agentSessionRefusalCauseParts,
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts
} from './agent-session-refusal-notice'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure
} from './agent-session-write-failure'

describe('agentSessionRefusalCauseParts', () => {
  it.each(['managed', 'system'] as const)(
    'retains the %s account when saving a refused message',
    (account) => {
      const refusal = {
        code: 'agent_session_operation_invalid',
        details: { reason: 'notSignedIn', account }
      } as const
      const saved = agentSessionRefusalFailure(refusal)
      expect(saved.details).toEqual(refusal.details)
      const parts = agentSessionRefusalCauseParts(saved, { agentName: 'Claude' })
      expect(agentSessionWriteNoticeEnglish(parts)).toBe(
        agentSessionFailureSentence({ kind: 'notSignedIn', account }, 'rejection', {
          agentName: 'Claude'
        })
      )
    }
  )

  // A failed start the host refused for a running terminal says so; only a named chat is another chat.
  it('names the terminal that holds the conversation unless the refusal names a chat', () => {
    const held = agentSessionRefusalFailure({
      code: 'agent_session_conflict',
      details: { reason: 'conversationHeldElsewhere' }
    })
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionRefusalCauseParts({ ...held, owner: null }, { agentName: 'Claude' })
      )
    ).toBe(
      'Claude is already running this conversation in another terminal. Quit Claude there or close that terminal to continue here.'
    )
    const namingChat = { ...held, owner: { sessionId: 'chat-1', workspaceId: 'wt-1' } }
    expect(agentSessionRefusalCauseParts(namingChat)).toEqual([])
  })

  // The write failure drops the owner, so its words cannot tell a holding chat from a terminal.
  it('keeps a send refusal naming its holding chat from reading as a terminal', () => {
    const namingChat = agentSessionRefusalFailure({
      code: 'agent_session_conflict',
      details: {
        reason: 'conversationHeldElsewhere',
        owner: { sessionId: 'holding-chat', workspaceId: 'repo::/srv/app' }
      }
    })
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionWriteNoticeParts(namingChat, 'composer-send', { agentName: 'Claude' })
      )
    ).not.toMatch(/terminal/)
  })
})

describe('saved Arguments refusals', () => {
  it('keeps the validated cause after durable parsing and names the correction beside Retry', () => {
    const refused = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: {
        reason: 'attachFailed',
        argumentProblem: { agent: 'Codex', option: '--remote', problem: 'unsupportedOption' }
      }
    })
    const parsed = parseAgentSessionWriteFailure(JSON.parse(JSON.stringify(refused)))
    if (!parsed) {
      throw new Error('saved refusal was not read')
    }
    expect(agentSessionWriteNoticeEnglish(agentSessionRefusalCauseParts(parsed))).toBe(
      "Codex couldn't start. Saved Arguments contain an unsupported option (--remote). Edit them in Settings > Agents > Arguments."
    )
  })

  it.each([
    { agent: 'Codex', option: '--remote', problem: 'futureProblem' },
    { agent: 'Codex', option: '--remote=private', problem: 'unsupportedOption' }
  ])('ignores an unrecognized or unsafe argument detail', (argumentProblem) => {
    const refused = parseAgentSessionWriteFailure({
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'attachFailed', argumentProblem }
    })
    expect(refused).toEqual({
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'attachFailed' }
    })
    if (!refused) {
      throw new Error('refusal was not read')
    }
    expect(agentSessionRefusalCauseParts(refused)).toEqual([])
  })
})

describe('an expired attachment refusal', () => {
  const notice = (details: unknown): string =>
    agentSessionWriteNoticeEnglish(
      agentSessionWriteNoticeParts(
        agentSessionRefusalFailure({ code: 'agent_session_operation_invalid', details }),
        'composer-send'
      )
    )
  const expired = (...names: string[]) => ({
    reason: 'attachmentExpired',
    expiredAttachments: names.map((name, index) => ({ uploadId: `upload-${index}`, name }))
  })

  it('names the file', () => {
    expect(notice(expired('notes.pdf'))).toBe(
      'notes.pdf expired. Your message was not sent. Remove it and attach it again.'
    )
  })

  it('names several, then stops short of a long list', () => {
    expect(notice(expired('a.pdf', 'b.pdf'))).toBe(
      'a.pdf, b.pdf expired. Your message was not sent. Remove them and attach them again.'
    )
    expect(notice(expired('a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'))).toBe(
      'a.pdf, b.pdf, c.pdf… expired. Your message was not sent. Remove them and attach them again.'
    )
  })

  it.each(['orca-paste-1-abc.png', 'orca-paste-1-abc.txt'])(
    "keeps a paste's generated name out of the words: %s",
    (name) => {
      expect(notice(expired(name))).toBe(
        'This attachment expired. Your message was not sent. Remove it and attach it again.'
      )
    }
  )

  it.each([
    ['an older host, which names none', { reason: 'attachmentExpired' }],
    ['a list it cannot read', { reason: 'attachmentExpired', expiredAttachments: [{ name: 1 }] }]
  ])('stays generic for %s', (_case, details) => {
    expect(notice(details)).toBe(
      'This attachment expired. Your message was not sent. Remove it and attach it again.'
    )
  })
})
