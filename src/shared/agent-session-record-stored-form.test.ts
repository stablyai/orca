import { describe, expect, it } from 'vitest'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import {
  agentSessionJournalProviderHandle,
  agentSessionProviderHandleFromWire,
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  agentSessionWireProviderHandle,
  claudeProviderHandle,
  codexProviderHandle,
  decodePersistedAgentSessionProviderHandle,
  encodePersistedAgentSessionProviderHandle
} from './agent-session-provider-handle-encoding'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from './agent-session-record-stored-form'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from './agent-session-record.test-fixture'

/** The rules of the handle guard builds before the neutral handle shipped ran on every stored one. */
function olderBuildReadsHandle(value: unknown): boolean {
  const isHandleField = (field: unknown): boolean =>
    typeof field === 'string' && field.length > 0 && field.length <= 512 && field === field.trim()
  if (typeof value !== 'object' || value === null || !('provider' in value)) {
    return false
  }
  if (value.provider === 'claude') {
    return (
      'sessionId' in value &&
      isHandleField(value.sessionId) &&
      'leafUuid' in value &&
      (value.leafUuid === null || isHandleField(value.leafUuid))
    )
  }
  return value.provider === 'codex' && 'threadId' in value && isHandleField(value.threadId)
}

/** A Claude record row exactly as builds before this change wrote it: a fork with its seed key. */
const STORED_CLAUDE_ROW = JSON.stringify({
  schemaVersion: 2,
  sessionId: 'session-alpha-1',
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  },
  provider: 'claude',
  providerHandleChain: [
    {
      linkId: 'link-1',
      handle: { provider: 'claude', sessionId: 'sess-1', leafUuid: 'leaf-1' },
      origin: 'created',
      mintedAtFence: 6,
      observedAt: 1000
    },
    {
      linkId: 'link-2',
      handle: { provider: 'claude', sessionId: 'sess-2', leafUuid: null },
      origin: 'forked',
      mintedAtFence: 7,
      observedAt: 1500,
      forkedFromKey: 'claude:["sess-1","leaf-1"]'
    }
  ],
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/user/.claude' },
  lease: agentSessionLeaseFixture({ provenHandleLinkId: 'link-2' }),
  createdAt: 1000,
  updatedAt: 2000
})

/** A Codex row with a creation that replaced one Codex never saved. */
const STORED_CODEX_ROW = JSON.stringify({
  ...JSON.parse(STORED_CLAUDE_ROW),
  provider: 'codex',
  providerHandleChain: [
    {
      linkId: 'codex-7-thread-new',
      handle: { provider: 'codex', threadId: 'thread-new' },
      origin: 'created',
      mintedAtFence: 7,
      observedAt: 1500,
      supersedesKey: 'codex:"thread-unsaved"'
    }
  ],
  accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' },
  lease: agentSessionLeaseFixture({ provenHandleLinkId: 'codex-7-thread-new' })
})

describe('a record row older builds wrote', () => {
  it.each([
    ['Claude', STORED_CLAUDE_ROW],
    ['Codex', STORED_CODEX_ROW]
  ])('reads a %s row and writes it back byte for byte', (_name, row) => {
    const stored: unknown = JSON.parse(row)
    expect(isPersistedAgentSessionRecord(stored)).toBe(true)
    if (!isPersistedAgentSessionRecord(stored)) {
      return
    }
    const { record, normalized } = decodePersistedAgentSessionRecord(stored)
    expect(normalized).toBe(false)
    expect(JSON.stringify(encodeAgentSessionRecord(record))).toBe(row)
  })

  it('hands shared code only the neutral handle', () => {
    const stored: unknown = JSON.parse(STORED_CLAUDE_ROW)
    if (!isPersistedAgentSessionRecord(stored)) {
      throw new Error('fixture row must be readable')
    }
    const { record } = decodePersistedAgentSessionRecord(stored)
    expect(record.providerHandleChain.map((link) => link.handle)).toEqual([
      { transport: 'claude-sdk', agent: 'claude', nativeId: 'sess-1', resumeCursor: 'leaf-1' },
      { transport: 'claude-sdk', agent: 'claude', nativeId: 'sess-2' }
    ])
  })

  it('still reports a lease only the removed terminal handoff wrote', () => {
    const record = agentSessionRecordFixture()
    const stored = encodeAgentSessionRecord(record)
    expect(decodePersistedAgentSessionRecord(stored)).toEqual({ record, normalized: false })
    const legacy = { ...stored, lease: { ...stored.lease, runtimeKind: 'tui' as const } }
    expect(decodePersistedAgentSessionRecord(legacy)).toEqual({
      record: { ...record, lease: { ...record.lease, claimStatus: 'conflicted' } },
      normalized: true
    })
  })
})

describe('what this build writes', () => {
  it('stores Claude and Codex handles in the typed form older builds read', () => {
    const claude = claudeProviderHandle('sess-1', 'leaf-1')
    const codex = codexProviderHandle('thread-1')
    expect(encodePersistedAgentSessionProviderHandle(claude)).toEqual({
      provider: 'claude',
      sessionId: 'sess-1',
      leafUuid: 'leaf-1'
    })
    expect(encodePersistedAgentSessionProviderHandle(claudeProviderHandle('sess-1', null))).toEqual(
      { provider: 'claude', sessionId: 'sess-1', leafUuid: null }
    )
    expect(encodePersistedAgentSessionProviderHandle(codex)).toEqual({
      provider: 'codex',
      threadId: 'thread-1'
    })
    for (const handle of [claude, codex]) {
      const stored = encodePersistedAgentSessionProviderHandle(handle)
      expect(olderBuildReadsHandle(stored)).toBe(true)
      expect(decodePersistedAgentSessionProviderHandle(stored)).toEqual(handle)
    }
  })

  it('keeps the persisted key and root strings older builds derived', () => {
    // Fork seeds, superseded creations and resume offers store these; a new spelling strands them.
    const claude = claudeProviderHandle('sess-1', 'leaf-1')
    expect(agentSessionProviderHandleKey(claude)).toBe('claude:["sess-1","leaf-1"]')
    expect(agentSessionProviderHandleKey(claudeProviderHandle('sess-1', null))).toBe(
      'claude:["sess-1",null]'
    )
    expect(agentSessionProviderHandleRoot(claude)).toBe('claude:"sess-1"')
    expect(agentSessionProviderHandleKey(codexProviderHandle('t'))).toBe('codex:"t"')
    expect(agentSessionProviderHandleRoot(codexProviderHandle('t'))).toBe('codex:"t"')
  })

  it('round-trips another transport in the neutral form, which an older build refuses', () => {
    const grok = {
      transport: 'acp',
      agent: 'grok',
      nativeId: 'acp-session-1',
      resumeCursor: '{"cwd":"/repo"}'
    }
    const stored = encodePersistedAgentSessionProviderHandle(grok)
    expect(stored).toEqual(grok)
    expect(decodePersistedAgentSessionProviderHandle(JSON.parse(JSON.stringify(stored)))).toEqual(
      grok
    )
    // Unknown providers must never impersonate Codex on an older build.
    expect(olderBuildReadsHandle(stored)).toBe(false)
    expect(isAgentSessionHandleProvider(grok.agent)).toBe(false)
    expect(agentSessionWireProviderHandle(grok)).toBeNull()
    // Root, not the resume cursor: the cursor is resume state, not identity.
    expect(agentSessionProviderHandleRoot(grok)).toBe('acp/grok:"acp-session-1"')
    expect(agentSessionProviderHandleKey(grok)).toBe(agentSessionProviderHandleRoot(grok))
  })

  it('refuses a stored handle that is not the one form its transport writes', () => {
    for (const value of [
      // Claude or Codex in the neutral form: no build writes it.
      { transport: 'claude-sdk', agent: 'claude', nativeId: 'sess-1' },
      { transport: 'codex-app-server', agent: 'codex', nativeId: 'thread-1' },
      // Both forms at once: reading either identity would erase the other.
      { provider: 'grok', transport: 'acp', agent: 'grok', nativeId: 'x' },
      {
        provider: 'codex',
        threadId: 'thread-1',
        transport: 'acp',
        agent: 'grok',
        nativeId: 'acp-thread',
        resumeCursor: 'resume-token'
      },
      { provider: 'codex', threadId: 'thread-1', nativeId: 'other-thread' },
      {
        provider: 'claude',
        sessionId: 'sess-1',
        leafUuid: null,
        transport: 'acp',
        agent: 'grok',
        nativeId: 'other'
      },
      { provider: 'claude', sessionId: 'sess-1', leafUuid: null, resumeCursor: 'leaf-2' },
      { provider: 'claude', sessionId: 'sess-1' },
      { provider: 'claude', sessionId: 'sess-1', leafUuid: '' },
      { provider: 'codex', threadId: ' padded ' },
      { transport: 'a:b', agent: 'grok', nativeId: 'x' },
      { transport: 'acp', agent: 'grok', nativeId: 'x', resumeCursor: '' },
      null
    ]) {
      expect(decodePersistedAgentSessionProviderHandle(value)).toBeNull()
    }
  })

  it('still reads a typed handle that carries an unrelated field', () => {
    expect(
      decodePersistedAgentSessionProviderHandle({ provider: 'codex', threadId: 't', note: 1 })
    ).toEqual(codexProviderHandle('t'))
    expect(
      decodePersistedAgentSessionProviderHandle({
        provider: 'claude',
        sessionId: 'sess-1',
        leafUuid: 'leaf-1',
        note: 1
      })
    ).toEqual(claudeProviderHandle('sess-1', 'leaf-1'))
  })

  it('drops a field a later build put on a handle, but keeps one on the link or record', () => {
    const stored = JSON.parse(STORED_CODEX_ROW)
    stored.providerHandleChain[0].handle.laterHandleField = 'x'
    stored.providerHandleChain[0].laterLinkField = 'y'
    stored.laterRecordField = 'z'
    expect(isPersistedAgentSessionRecord(stored)).toBe(true)
    if (!isPersistedAgentSessionRecord(stored)) {
      return
    }
    const written = JSON.parse(
      JSON.stringify(encodeAgentSessionRecord(decodePersistedAgentSessionRecord(stored).record))
    )
    expect(written.laterRecordField).toBe('z')
    expect(written.providerHandleChain[0].laterLinkField).toBe('y')
    expect(written.providerHandleChain[0].handle).toEqual({
      provider: 'codex',
      threadId: 'thread-new'
    })

    const neutral = { transport: 'acp', agent: 'grok', nativeId: 's', resumeCursor: 'c' }
    const decoded = decodePersistedAgentSessionProviderHandle({ ...neutral, laterHandleField: 1 })
    expect(decoded && encodePersistedAgentSessionProviderHandle(decoded)).toEqual(neutral)
  })

  it.each([
    ['Claude', STORED_CLAUDE_ROW],
    ['Codex', STORED_CODEX_ROW]
  ])('refuses a whole %s row whose handle also names a neutral identity', (_name, row) => {
    const stored = JSON.parse(row)
    Object.assign(stored.providerHandleChain[0].handle, {
      transport: 'acp',
      agent: 'grok',
      nativeId: 'acp-thread',
      resumeCursor: 'resume-token'
    })
    expect(isPersistedAgentSessionRecord(stored)).toBe(false)
  })
})

describe('the wire and journal forms', () => {
  it('maps the attach wire handle both ways for Claude and Codex', () => {
    const claudeWire = { kind: 'claude', sessionId: 'sess-1', leafUuid: null } as const
    const codexWire = { kind: 'codex', threadId: 'thread-1' } as const
    expect(agentSessionProviderHandleFromWire(claudeWire)).toEqual(
      claudeProviderHandle('sess-1', null)
    )
    expect(agentSessionWireProviderHandle(agentSessionProviderHandleFromWire(claudeWire))).toEqual(
      claudeWire
    )
    expect(agentSessionWireProviderHandle(agentSessionProviderHandleFromWire(codexWire))).toEqual(
      codexWire
    )
  })

  it('records the journal rows exactly as before, and another transport as opaque', () => {
    expect(
      agentSessionJournalProviderHandle({
        agent: 'claude',
        providerHandle: claudeProviderHandle('sess-1', 'leaf-1')
      })
    ).toEqual({ kind: 'claude', sessionId: 'sess-1', leafUuid: 'leaf-1' })
    expect(
      agentSessionJournalProviderHandle({
        agent: 'codex',
        providerHandle: codexProviderHandle('t')
      })
    ).toEqual({ kind: 'codex', threadId: 't' })
    expect(agentSessionJournalProviderHandle({ agent: 'codex', providerHandle: null })).toEqual({
      kind: 'opaque',
      agent: 'codex',
      value: 'pending'
    })
    expect(
      agentSessionJournalProviderHandle({
        agent: 'grok',
        providerHandle: { transport: 'acp', agent: 'grok', nativeId: 's' }
      })
    ).toEqual({ kind: 'opaque', agent: 'grok', value: 's' })
  })
})
