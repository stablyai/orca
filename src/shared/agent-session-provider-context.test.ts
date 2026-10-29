import { describe, expect, it } from 'vitest'
import {
  activeProviderContext,
  isAgentSessionProviderContextBoundary
} from './agent-session-provider-context'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { encodeAgentSessionRecord } from './agent-session-record-stored-form'

const boundary = { operationId: 'clear-operation', afterFence: 3, clearedAt: 5000 }

describe('provider context after clear', () => {
  it('has no provider handle while the fresh context has not started', () => {
    expect(
      activeProviderContext({ providerHandleChain: [], providerContextBoundary: boundary })
    ).toEqual({
      head: null,
      handleChain: [],
      pendingClear: true
    })
  })

  it('uses the chain head after fresh creation without filtering or replacing proof', () => {
    const original = agentSessionRecordFixture()
    const first = original.providerHandleChain[0]
    if (!first) {
      throw new Error('Missing fixture handle')
    }
    const last = {
      ...first,
      linkId: 'link-2',
      origin: 'resumed' as const,
      observedAt: 2_000,
      mintedAtFence: original.lease.runtimeFence + 1
    }
    const record = {
      ...original,
      lease: {
        ...original.lease,
        runtimeFence: last.mintedAtFence,
        provenHandleLinkId: last.linkId
      },
      providerHandleChain: [first, last],
      providerContextBoundary: boundary
    }
    expect(activeProviderContext(record)).toEqual({
      head: last,
      handleChain: record.providerHandleChain,
      pendingClear: false
    })
    expect(activeProviderContext(record).handleChain).toBe(record.providerHandleChain)
    expect(isPersistedAgentSessionRecord(encodeAgentSessionRecord(record))).toBe(true)
  })

  it('rejects a boundary beyond the record fence', () => {
    const record = agentSessionRecordFixture()
    expect(
      isPersistedAgentSessionRecord(
        encodeAgentSessionRecord({
          ...record,
          providerContextBoundary: { ...boundary, afterFence: record.lease.runtimeFence + 1 }
        })
      )
    ).toBe(false)
  })

  it.each([
    {},
    { ...boundary, afterFence: -1 },
    { ...boundary, clearedAt: Number.NaN },
    { ...boundary, operationId: '' }
  ])('rejects malformed boundary metadata', (value) =>
    expect(isAgentSessionProviderContextBoundary(value)).toBe(false)
  )
})
