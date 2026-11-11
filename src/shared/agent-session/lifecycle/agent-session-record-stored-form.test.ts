import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  decodePersistedAgentSessionProviderHandleChain,
  encodePersistedAgentSessionProviderHandleChain,
  type AgentSessionProviderHandle,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  claudeProviderHandle,
  codexProviderHandle,
  decodePersistedAgentSessionProviderHandle,
  encodePersistedAgentSessionProviderHandle
} from './agent-session-provider-handle-encoding'
import {
  isPersistedAgentSessionRecord,
  type AgentSessionRecord,
  type AgentSessionLease
} from './agent-session-record'
import { normalizeLegacyHandoffLease } from './agent-session-legacy-handoff-lease'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from './agent-session-record-stored-form'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from './agent-session-record.test-fixture'

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
    expectTypeOf(record).toMatchTypeOf<AgentSessionRecord>()
    expect(JSON.stringify(encodeAgentSessionRecord(record))).toBe(row)
  })

  it('still reports a lease only the removed terminal handoff wrote', () => {
    const record = agentSessionRecordFixture()
    const stored = encodeAgentSessionRecord(record)
    expect(decodePersistedAgentSessionRecord(stored)).toEqual({ record, normalized: false })
    const lease = {
      ...stored.lease,
      runtimeKind: 'tui' as const,
      handoffStage: 'preparing' as const,
      claimStatus: 'live' as const
    }
    const normalized = normalizeLegacyHandoffLease(lease)
    expectTypeOf(normalized.runtimeKind).toEqualTypeOf<AgentSessionLease['runtimeKind']>()
    expectTypeOf(normalized.handoffStage).toEqualTypeOf<AgentSessionLease['handoffStage']>()
    expectTypeOf(normalized.claimStatus).toEqualTypeOf<AgentSessionLease['claimStatus']>()
    const decoded = decodePersistedAgentSessionRecord({ ...stored, lease })
    expectTypeOf(decoded.record).toMatchTypeOf<AgentSessionRecord>()
    expect(decoded).toEqual({
      record: {
        ...record,
        lease: { ...record.lease, claimStatus: 'conflicted', handoffStage: 'recovering' }
      },
      normalized: true
    })
    const unknownFloor: unknown = 'bad'
    const observed = decodePersistedAgentSessionRecord({
      ...stored,
      lease: { ...lease, minimumNextFence: unknownFloor }
    })
    expectTypeOf(observed.record.lease.minimumNextFence).toEqualTypeOf<unknown>()
    expectTypeOf(observed.record).not.toMatchTypeOf<AgentSessionRecord>()
    expect(observed.record.lease.minimumNextFence).toBe('bad')
  })
})

describe('what this build writes', () => {
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

describe('a chat whose saved conversation could not be restored', () => {
  const acp = (nativeId: string): AgentSessionProviderHandle => ({
    transport: 'acp',
    agent: 'grok',
    nativeId
  })
  const link = (
    linkId: string,
    nativeId: string,
    fence: number,
    extra: Partial<AgentSessionProviderHandleLink> = {}
  ): AgentSessionProviderHandleLink => ({
    linkId,
    handle: acp(nativeId),
    origin: 'created',
    mintedAtFence: fence,
    observedAt: fence * 1_000,
    ...extra
  })
  const lost = (nativeId: string, replacedAt: number) => ({
    key: agentSessionProviderHandleKey(acp(nativeId)),
    reason: 'restore-failed',
    replacedAt
  })
  // Opened, reopened, lost and replaced twice, and the second replacement reopened.
  const chain = [
    link('l1', 's-1', 1),
    link('l2', 's-1', 2, { origin: 'resumed' }),
    link('l3', 's-2', 3, { replaces: lost('s-1', 3_000) }),
    link('l4', 's-3', 4, { replaces: lost('s-2', 4_000) }),
    link('l5', 's-3', 7, { origin: 'resumed' })
  ]

  it('stores the chain as it is held, and reads every link back', () => {
    const stored = JSON.parse(JSON.stringify(encodePersistedAgentSessionProviderHandleChain(chain)))
    expect(stored).toEqual(chain)
    expect(decodePersistedAgentSessionProviderHandleChain(stored)).toEqual(chain)
  })

  it('refuses a stored replacement that opens the chain or names another conversation', () => {
    const stored = JSON.parse(JSON.stringify(encodePersistedAgentSessionProviderHandleChain(chain)))
    expect(decodePersistedAgentSessionProviderHandleChain(stored.slice(2))).toBeNull()
    stored[3].replaces.key = agentSessionProviderHandleKey(acp('s-1'))
    expect(decodePersistedAgentSessionProviderHandleChain(stored)).toBeNull()
  })
})

it('preserves the saved turn and unknown JSON through a record transition', () => {
  const stored = {
    ...encodeAgentSessionRecord(agentSessionRecordFixture()),
    lastTurn: { state: 'settled', outcome: 'success', at: 10 },
    laterField: 'keep'
  }
  const record = decodePersistedAgentSessionRecord(stored).record
  expect(encodeAgentSessionRecord({ ...record, updatedAt: 20 })).toMatchObject({
    lastTurn: stored.lastTurn,
    laterField: 'keep'
  })
})

it('stores a delivered kill in the form older builds read and reads only that exact pair back', () => {
  const evidence = { detail: 'killed', observedAt: 40, ownerFence: 7 } as const
  const withEvidence = (deathEvidence: unknown) => ({
    ...encodeAgentSessionRecord(agentSessionRecordFixture()),
    lease: { ...agentSessionLeaseFixture({ claimStatus: 'released' }), deathEvidence }
  })
  const killed = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      claimStatus: 'released',
      deathEvidence: { kind: 'kill-delivered', ...evidence }
    })
  )
  const stored = encodeAgentSessionRecord(killed)
  expect(stored.lease.deathEvidence).toEqual({ kind: 'pid-absent', delivery: 'kill', ...evidence })
  expect(isPersistedAgentSessionRecord(stored)).toBe(true)
  expect(decodePersistedAgentSessionRecord(stored).record).toEqual(killed)
  // Rows written before this encoding, a plain absent pid, and stale or foreign markers.
  for (const [saved, read] of [
    [
      { kind: 'kill-delivered', ...evidence },
      { kind: 'kill-delivered', ...evidence }
    ],
    [
      { kind: 'pid-absent', ...evidence },
      { kind: 'pid-absent', ...evidence }
    ],
    [
      { kind: 'pid-absent', delivery: 'signal', ...evidence },
      { kind: 'pid-absent', ...evidence }
    ],
    [
      { kind: 'exit-observed', delivery: 'kill', ...evidence },
      { kind: 'exit-observed', ...evidence }
    ]
  ]) {
    const row: unknown = withEvidence(saved)
    if (!isPersistedAgentSessionRecord(row)) {
      throw new Error('the stored evidence fixture must pass record validation')
    }
    expect(decodePersistedAgentSessionRecord(row).record.lease.deathEvidence).toEqual(read)
  }
})
