import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
