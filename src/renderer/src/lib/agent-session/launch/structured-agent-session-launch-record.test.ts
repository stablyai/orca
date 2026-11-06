import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSavedLaunchRecord } from './structured-agent-session-launch-journal-codec'
import { validRecord } from './structured-agent-session-launch-record'

const record = {
  sessionId: 'codex_11111111_2222_3333_4444_555555555555',
  executionHostId: 'local',
  agent: 'codex',
  lifecycle: 'visibility-unknown',
  clientOperationId: 'create-operation',
  payloadFingerprint: 'a'.repeat(64),
  expectedRuntimeFence: null,
  createMessageSupport: true,
  firstMessage: {
    clientMessageId: 'opening-message',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'opening π text' }] }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('a persisted create opening message', () => {
  it('loads the frozen user message in a browser without Node Buffer', () => {
    vi.stubGlobal('Buffer', undefined)
    expect(() => validRecord(record)).not.toThrow()
    expect(validRecord(record)).toBe(true)
  })

  it.each([
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'forged response' }] },
    { kind: 'message', role: 'user', blocks: [{ type: 'tool-call', name: 'forged tool' }] },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 5 }] }
  ])('refuses a saved opening body that cannot be sent through the user-message wire', (body) => {
    expect(validRecord({ ...record, firstMessage: { ...record.firstMessage, body } })).toBe(false)
  })
})

describe('a saved host launch first turn', () => {
  const image = '/client/shot.png'
  const held = {
    ...record,
    hostLaunchOperationId: 'launch-operation',
    firstMessage: {
      clientMessageId: 'opening-message',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'fix this' },
          { type: 'image-ref', path: image }
        ]
      }
    }
  }
  const choices = { options: {}, selection: {} }

  it.each([
    [
      'still editing, with its message’s files to upload',
      { phase: 'editing', staged: [image] },
      true
    ],
    ['submitted, its message already on the host', { phase: 'submitted' }, true],
    ['submitted yet still owing uploads', { phase: 'submitted', staged: [image] }, false],
    [
      'editing a file its message never names',
      { phase: 'editing', staged: ['/client/x.png'] },
      false
    ]
  ])('%s', (_case, phase, readable) => {
    const saved = readSavedLaunchRecord({ ...held, hostLaunchFirstTurn: { ...choices, ...phase } })
    expect(saved?.hostLaunchFirstTurn !== undefined).toBe(readable)
  })

  it('reads nothing owed without the message the files belong to', () => {
    const { firstMessage: _message, ...withoutMessage } = held
    const saved = readSavedLaunchRecord({
      ...withoutMessage,
      hostLaunchFirstTurn: { ...choices, phase: 'editing', staged: [image] }
    })
    expect(saved?.hostLaunchFirstTurn).toBeUndefined()
  })
})
