import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from './agent-status-types'
import {
  conversationIsOfferedWithoutStatus,
  conversationReportKey,
  readTerminalConversationIdentity,
  selectTerminalConversation,
  terminalConversationIdentityEqual,
  type TerminalConversationIdentity
} from './terminal-conversation-identity'

const S = { key: 'session_id' as const, id: 'S', transcriptPath: '/t/S.jsonl' }
const T = { key: 'session_id' as const, id: 'T' }
const field: TerminalConversationIdentity = {
  agentType: 'codex',
  providerSession: S,
  model: 'P',
  capturedAt: 100,
  source: 'live'
}

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    paneKey: 'tab:leaf',
    agentType: 'codex',
    ...overrides
  }
}

describe('readTerminalConversationIdentity', () => {
  it('reads absent, null and malformed all as undefined', () => {
    expect(readTerminalConversationIdentity(undefined)).toBeUndefined()
    expect(readTerminalConversationIdentity(null)).toBeUndefined()
    expect(readTerminalConversationIdentity({ agentType: 'codex' })).toBeUndefined()
    expect(readTerminalConversationIdentity({ ...field, capturedAt: 'x' })).toBeUndefined()
    expect(readTerminalConversationIdentity({ ...field, source: 3 })).toBeUndefined()
    expect(
      readTerminalConversationIdentity({ ...field, modelSwitchCommand: 'other' })
    ).toBeUndefined()
    expect(readTerminalConversationIdentity(field)).toEqual(field)
  })

  it('keeps an unknown future source value instead of discarding the identity', () => {
    expect(readTerminalConversationIdentity({ ...field, source: 'future' })).toMatchObject({
      source: 'future'
    })
  })
})

describe('terminalConversationIdentityEqual', () => {
  it('compares every member, including the transcript path', () => {
    expect(terminalConversationIdentityEqual(field, { ...field })).toBe(true)
    expect(
      terminalConversationIdentityEqual(field, {
        ...field,
        providerSession: { ...S, transcriptPath: '/other' }
      })
    ).toBe(false)
    expect(terminalConversationIdentityEqual(field, { ...field, capturedAt: 101 })).toBe(false)
    expect(terminalConversationIdentityEqual(field, { ...field, source: 'retained' })).toBe(false)
    expect(terminalConversationIdentityEqual(field, undefined)).toBe(false)
    expect(terminalConversationIdentityEqual(undefined, undefined)).toBe(true)
  })
})

describe('conversationIsOfferedWithoutStatus', () => {
  it('needs no status, the true-only offer and an identity object', () => {
    const offered = { conversationIdentity: field, conversationOfferedWithoutStatus: true }
    expect(conversationIsOfferedWithoutStatus(offered)).toBe(true)
    expect(conversationIsOfferedWithoutStatus({ ...offered, agentStatus: status() })).toBe(false)
    expect(conversationIsOfferedWithoutStatus({ conversationIdentity: field })).toBe(false)
    expect(
      conversationIsOfferedWithoutStatus({ ...offered, conversationOfferedWithoutStatus: 'yes' })
    ).toBe(false)
    expect(conversationIsOfferedWithoutStatus({ ...offered, conversationIdentity: null })).toBe(
      false
    )
  })
})

describe('selectTerminalConversation', () => {
  const absent = (agentStatus: AgentStatusEntry | null, agent = 'codex') =>
    selectTerminalConversation({ agentStatus, agent })

  it.each([
    ['absent', undefined, true],
    ['malformed', { agentType: 'codex' }, true],
    ['not offered on a statusless tab', field, undefined],
    ['for another agent', { ...field, agentType: 'claude' }, true]
  ])('reads a field that is %s exactly as an old host', (_name, conversationIdentity, offer) => {
    const genuine = status({ providerSession: T, model: 'Q', modelSwitchCommand: 'orca-model' })
    // Why: "not offered" only describes a statusless tab; beside a status the field is usable.
    for (const agentStatus of offer === undefined ? [null] : [null, genuine]) {
      // Why: an offer never accompanies a genuine status, so only the statusless read uses it.
      const offered = agentStatus ? undefined : offer
      const selection = selectTerminalConversation({
        conversationIdentity,
        conversationOfferedWithoutStatus: offered,
        agentStatus,
        agent: 'codex'
      })
      expect(selection.authority).toBe('none')
      expect(selection).toEqual(absent(agentStatus))
    }
  })

  it('gives an offered statusless field the address and its model', () => {
    expect(
      selectTerminalConversation({
        conversationIdentity: field,
        conversationOfferedWithoutStatus: true,
        agent: 'codex'
      })
    ).toEqual({
      authority: 'address',
      address: { agentType: 'codex', providerSession: S },
      model: 'P',
      modelSwitchCommand: null,
      modelSource: 'field',
      fieldReportKey: conversationReportKey(field)
    })
  })

  it('takes the field address over a conflicting status, and the field model', () => {
    const selection = selectTerminalConversation({
      conversationIdentity: field,
      agentStatus: status({ providerSession: T, model: 'Q' }),
      agent: 'codex'
    })
    expect(selection).toMatchObject({
      authority: 'address',
      address: { providerSession: S },
      model: 'P',
      modelSource: 'field'
    })
  })

  it.each([
    ['the same conversation', S],
    ['no address (a model-only report)', undefined]
  ])('lets a genuine status for %s supply a newer model', (_name, providerSession) => {
    const selection = selectTerminalConversation({
      conversationIdentity: field,
      agentStatus: status({ providerSession, model: 'Q', modelSwitchCommand: 'orca-model' }),
      agent: 'codex'
    })
    expect(selection).toMatchObject({
      authority: 'address',
      address: { providerSession: S },
      model: 'Q',
      modelSwitchCommand: 'orca-model',
      modelSource: 'status',
      // Why: the field is still observed while a status supplies the model.
      fieldReportKey: conversationReportKey(field)
    })
  })

  it('falls back to the field model when the status carries none', () => {
    expect(
      selectTerminalConversation({
        conversationIdentity: field,
        agentStatus: status({ providerSession: S }),
        agent: 'codex'
      })
    ).toMatchObject({ model: 'P', modelSource: 'field' })
  })

  it('reports no model source and no report key when nothing carries a model', () => {
    const { model: _model, ...modelless } = field
    expect(
      selectTerminalConversation({
        conversationIdentity: modelless,
        conversationOfferedWithoutStatus: true,
        agent: 'codex'
      })
    ).toMatchObject({ authority: 'address', model: null, modelSource: null, fieldReportKey: null })
  })

  it('reads a null field as absent: the genuine status address still answers', () => {
    expect(
      selectTerminalConversation({
        conversationIdentity: null,
        agentStatus: status({ providerSession: T, model: 'Q' }),
        agent: 'codex'
      })
    ).toEqual({
      authority: 'none',
      address: { agentType: 'codex', providerSession: T },
      model: 'Q',
      modelSwitchCommand: null,
      modelSource: 'status',
      fieldReportKey: null
    })
  })

  it('reads a null field beside a model-only report as absent, seeding that model', () => {
    expect(
      selectTerminalConversation({
        conversationIdentity: null,
        agentStatus: status({ model: 'Q', modelSwitchCommand: 'orca-model' }),
        agent: 'codex'
      })
    ).toMatchObject({
      authority: 'none',
      address: null,
      model: 'Q',
      modelSwitchCommand: 'orca-model',
      modelSource: 'status'
    })
  })

  it('keeps an absent field model-only report seeding the model', () => {
    expect(absent(status({ model: 'Q' }))).toMatchObject({
      authority: 'none',
      address: null,
      model: 'Q',
      modelSource: 'status'
    })
  })

  it('never lets a caller take the agent from a statusless field the host did not offer', () => {
    expect(
      selectTerminalConversation({ conversationIdentity: field, agent: field.agentType })
    ).toMatchObject({ authority: 'none', address: null })
  })

  it('keys a report by conversation, clock, model and switch command', () => {
    const key = conversationReportKey(field)
    expect(conversationReportKey({ ...field })).toBe(key)
    expect(conversationReportKey({ ...field, model: 'Q' })).not.toBe(key)
    expect(conversationReportKey({ ...field, capturedAt: 101 })).not.toBe(key)
    expect(conversationReportKey({ ...field, modelSwitchCommand: 'orca-model' })).not.toBe(key)
    expect(conversationReportKey({ ...field, providerSession: T })).not.toBe(key)
  })
})
