import {
  parseDesktopCreateLaunchRecord,
  validRecord
} from './structured-agent-session-launch-record'
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  deleteStructuredAgentLaunchRecord,
  desktopCreateIdentityKey,
  readStructuredAgentLaunchRecords,
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchCancellationTombstoneSessionIds,
  retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted,
  retireStructuredAgentLaunchCancellationTombstonePersisted,
  writeStructuredAgentLaunchRecord,
  writeStructuredAgentLaunchRecords,
  markStructuredAgentLaunchCancelledPersisted,
  structuredAgentLaunchRecordFor
} from './structured-agent-session-launch-persistence'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'

const SERVER = 'runtime:server-1'
const TOMBSTONES_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'

function reload(): void {
  resetStructuredAgentLaunchPersistenceForTests()
}

describe('structured agent launch persistence', () => {
  it('reloads a frozen outer create as unknown, indexes one canonical record, and retires every alias without making it a strict create', () => {
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    const sessionId = 'codex_11111111_2222_4333_8444_555555555555'
    const params = {
      agent: 'codex',
      operationId: '1790000000123-0123456789abcdef0123456789abcdef',
      sessionId,
      paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      surface: 'chat',
      createIdentity: { instanceId: '94d38a16-e9db-4e86-b81d-334788958124' },
      target: { kind: 'create-worktree', create: { repo: 'repo', name: 'task', activate: true } },
      prompt: { text: 'immutable A', delivery: 'submit' }
    }
    const record = parseDesktopCreateLaunchRecord({
      sessionId,
      executionHostId: SERVER,
      agent: 'codex',
      lifecycle: 'pending',
      desktopCreate: { params }
    })
    expect(record).toBeDefined()
    if (!record) {
      throw new Error('valid outer record missing')
    }
    expect(Object.isFrozen(record.desktopCreate.params.target)).toBe(true)
    expect(Object.isFrozen(record.desktopCreate.params.prompt)).toBe(true)
    expect(validRecord(record)).toBe(false)
    for (const key of ['clientOperationId', 'payloadFingerprint', 'expectedRuntimeFence']) {
      expect(key in record).toBe(false)
    }
    expect(
      parseDesktopCreateLaunchRecord({ ...record, clientOperationId: 'strict' })
    ).toBeUndefined()
    expect(
      parseDesktopCreateLaunchRecord({
        ...record,
        desktopCreate: { params: { ...params, operationId: undefined } }
      })
    ).toBeUndefined()
    expect(
      validRecord({
        ...record,
        desktopCreate: null,
        clientOperationId: 'strict',
        payloadFingerprint: 'fp',
        expectedRuntimeFence: null
      })
    ).toBe(false)
    writeStructuredAgentLaunchRecord(record)
    expect(
      JSON.parse(localStorage.getItem('orca:structuredAgentLaunches:v1') ?? '[]')
    ).toHaveLength(1)
    reload()
    const restored = readStructuredAgentLaunchRecord(sessionId)
    const identityKey = desktopCreateIdentityKey(SERVER, params.createIdentity.instanceId)
    expect(restored).toMatchObject({ lifecycle: 'visibility-unknown', desktopCreate: { params } })
    expect(readStructuredAgentLaunchRecord(identityKey)).toBe(restored)
    expect(readStructuredAgentLaunchRecord(`desktop-pane:${SERVER}:${params.paneKey}`)).toBe(
      restored
    )
    expect(
      readStructuredAgentLaunchRecord(
        desktopCreateIdentityKey('local', params.createIdentity.instanceId)
      )
    ).toBeUndefined()
    expect(readStructuredAgentLaunchRecords()).toHaveLength(1)
    deleteStructuredAgentLaunchRecord(sessionId)
    expect(readStructuredAgentLaunchRecord(identityKey)).toBeUndefined()
    expect(
      readStructuredAgentLaunchRecord(`desktop-pane:${SERVER}:${params.paneKey}`)
    ).toBeUndefined()
    reload()
    expect(readStructuredAgentLaunchRecords()).toEqual([])
  })

  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
  })

  it('normalizes pending launches after a renderer reload', () => {
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        {
          sessionId: 'codex_session',
          surfaceAddress: {
            worktreeId: 'repo::/workspace',
            targetGroupId: 'original',
            precedingTabIds: ['source']
          },
          agent: 'codex',
          lifecycle: 'pending',
          clientOperationId: 'operation-1',
          payloadFingerprint: 'fingerprint-1',
          expectedRuntimeFence: null
        }
      ])
    )

    expect(readStructuredAgentLaunchRecord('codex_session')).toMatchObject({
      surfaceAddress: {
        worktreeId: 'repo::/workspace',
        targetGroupId: 'original',
        precedingTabIds: ['source']
      },
      lifecycle: 'visibility-unknown',
      clientOperationId: 'operation-1',
      // Written before a paired host could hold a chat, so it was launched on this machine.
      executionHostId: 'local'
    })
  })

  it("keeps a registered agent's launch across a reload and drops a record naming no agent", () => {
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify(
        [
          ['grok_session', 'grok'],
          ['bogus_session', 'not-an-agent']
        ].map(([sessionId, agent]) => ({
          sessionId,
          agent,
          lifecycle: 'pending',
          surfaceAddress: { worktreeId: 'workspace', precedingTabIds: [false] },
          clientOperationId: `${sessionId}-op`,
          payloadFingerprint: 'fingerprint',
          expectedRuntimeFence: null
        }))
      )
    )

    expect(readStructuredAgentLaunchRecord('grok_session')?.agent).toBe('grok')
    expect(readStructuredAgentLaunchRecord('grok_session')?.surfaceAddress).toBeUndefined()
    expect(readStructuredAgentLaunchRecord('bogus_session')).toBeUndefined()
  })

  it('keeps the host a launch was created on across a reload', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_remote',
      executionHostId: SERVER,
      agent: 'claude',
      lifecycle: 'pending',
      clientOperationId: 'operation-3',
      payloadFingerprint: 'fingerprint-3',
      expectedRuntimeFence: null
    })
    reload()

    expect(readStructuredAgentLaunchRecord('claude_remote')?.executionHostId).toBe(SERVER)
  })

  // This machine cannot re-derive a paired server's seed, so a reload must show the same one.
  it("keeps a paired server's reported seed across a reload, and no local one", () => {
    const intent = (
      executionHostId: 'local' | typeof SERVER,
      sessionId: string
    ): StructuredAgentSessionLaunchIntent => ({
      sessionId,
      worktreeId: 'workspace-1',
      executionHostId,
      target:
        executionHostId === 'local'
          ? { kind: 'local' }
          : { kind: 'environment', environmentId: 'server-1' },
      agent: 'claude',
      params: {
        envelope: {
          sessionId,
          clientOperationId: 'operation-9',
          expectedRuntimeFence: null,
          payloadFingerprint: 'fingerprint-9'
        },
        worktree: 'id:workspace-1',
        agent: 'claude'
      },
      seedOptions: { model: 'opus', fastMode: 'true' }
    })
    writeStructuredAgentLaunchRecord(
      structuredAgentLaunchRecordFor(intent(SERVER, 'claude_paired'), 'pending')
    )
    writeStructuredAgentLaunchRecord(
      structuredAgentLaunchRecordFor(intent('local', 'claude_local'), 'pending')
    )
    reload()

    expect(readStructuredAgentLaunchRecord('claude_paired')?.seedOptions).toEqual({
      model: 'opus',
      fastMode: 'true'
    })
    expect(readStructuredAgentLaunchRecord('claude_local')?.seedOptions).toBeUndefined()
  })

  it('drops a stored seed value that does not decode', () => {
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        {
          sessionId: 'claude_paired',
          executionHostId: SERVER,
          agent: 'claude',
          lifecycle: 'failed',
          clientOperationId: 'operation-1',
          payloadFingerprint: 'fingerprint-1',
          expectedRuntimeFence: null,
          seedOptions: { model: 'opus', fastMode: 'maybe' }
        }
      ])
    )

    expect(readStructuredAgentLaunchRecord('claude_paired')?.seedOptions).toEqual({
      model: 'opus'
    })
  })

  it('stores only content-free identity and preserves operation identity', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_session',
      executionHostId: 'local',
      agent: 'claude',
      lifecycle: 'visibility-unknown',
      clientOperationId: 'operation-2',
      payloadFingerprint: 'fingerprint-2',
      expectedRuntimeFence: null,
      resumeFrom: { providerSessionId: 'provider-thread' }
    })

    const raw = localStorage.getItem('orca:structuredAgentLaunches:v1') ?? ''
    expect(raw).toContain('claude_session')
    expect(raw).toContain('operation-2')
    expect(raw).not.toContain('prompt')
    expect(raw).not.toContain('branch')
    expect(raw).not.toContain('path')
    expect(readStructuredAgentLaunchRecord('claude_session')?.clientOperationId).toBe('operation-2')
  })

  it('keeps when a failed launch failed across a reload, and still loads records without it', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_session',
      executionHostId: 'local',
      agent: 'claude',
      lifecycle: 'failed',
      clientOperationId: 'operation-3',
      payloadFingerprint: 'fingerprint-3',
      expectedRuntimeFence: null,
      failedAt: 42_000
    })
    const stored = JSON.parse(localStorage.getItem('orca:structuredAgentLaunches:v1') ?? '[]')
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        ...stored,
        // Written by a build that did not save the failure time.
        { ...stored[0], sessionId: 'older_session', failedAt: undefined },
        { ...stored[0], sessionId: 'corrupt_session', failedAt: 'yesterday' }
      ])
    )
    resetStructuredAgentLaunchPersistenceForTests()

    expect(readStructuredAgentLaunchRecord('claude_session')).toMatchObject({
      lifecycle: 'failed',
      failedAt: 42_000
    })
    expect(readStructuredAgentLaunchRecord('older_session')).toMatchObject({ lifecycle: 'failed' })
    expect(readStructuredAgentLaunchRecord('older_session')?.failedAt).toBeUndefined()
    expect(readStructuredAgentLaunchRecord('corrupt_session')).toBeUndefined()
  })

  it('persists cancellation tombstones by session id and retires them', () => {
    markStructuredAgentLaunchCancelledPersisted('codex_session', 'local')
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(true)
    // A local chat's tombstone keeps the shape older builds read.
    expect(localStorage.getItem(TOMBSTONES_KEY)).toBe('["codex_session"]')
    expect(retireStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(true)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(false)
  })

  it("keeps a paired host's tombstone under that host across a reload", () => {
    markStructuredAgentLaunchCancelledPersisted('remote_session', SERVER)
    markStructuredAgentLaunchCancelledPersisted('local_session', 'local')
    reload()

    expect(readStructuredAgentLaunchCancellationTombstoneSessionIds(SERVER)).toEqual([
      'remote_session'
    ])
    expect(readStructuredAgentLaunchCancellationTombstoneSessionIds('local')).toEqual([
      'local_session'
    ])
  })

  it('retires only the tombstones of the host whose inventory omitted them', () => {
    markStructuredAgentLaunchCancelledPersisted('remote_session', SERVER)
    markStructuredAgentLaunchCancelledPersisted('local_session', 'local')

    expect(
      retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted(new Set(), 'local')
    ).toBe(true)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('local_session')).toBe(false)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('remote_session')).toBe(true)
  })

  it("expires a paired host's tombstone that host never answered for", () => {
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000
    localStorage.setItem(
      TOMBSTONES_KEY,
      JSON.stringify([
        { sessionId: 'stale_remote', executionHostId: SERVER, cancelledAt: expired },
        { sessionId: 'fresh_remote', executionHostId: SERVER, cancelledAt: Date.now() }
      ])
    )

    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('stale_remote')).toBe(false)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('fresh_remote')).toBe(true)
  })
})

it('loads once and serializes canonical records with linear work for N/10N ordinary and sparse outer owners', () => {
  const counts: number[][] = []
  for (const size of [10, 100]) {
    for (const outer of [false, true]) {
      localStorage.clear()
      resetStructuredAgentLaunchPersistenceForTests()
      const rows = Array.from({ length: size }, (_, i) => ({
        sessionId: `codex_${i}`,
        agent: 'codex',
        lifecycle: 'pending',
        clientOperationId: `operation-${i}`,
        payloadFingerprint: 'fp',
        expectedRuntimeFence: null
      }))
      const sparse = parseDesktopCreateLaunchRecord({
        sessionId: 'codex_11111111_2222_4333_8444_555555555555',
        executionHostId: 'local',
        agent: 'codex',
        lifecycle: 'pending',
        desktopCreate: {
          params: {
            agent: 'codex',
            operationId: '1790000000123-0123456789abcdef0123456789abcdef',
            sessionId: 'codex_11111111_2222_4333_8444_555555555555',
            paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            surface: 'chat',
            createIdentity: { instanceId: '94d38a16-e9db-4e86-b81d-334788958124' },
            target: { kind: 'create-worktree', create: { repo: 'repo', name: 'task' } }
          }
        }
      })
      if (!sparse) {
        throw new Error('outer fixture invalid')
      }
      localStorage.setItem(
        'orca:structuredAgentLaunches:v1',
        JSON.stringify([...rows, ...(outer ? [sparse, sparse] : [])])
      )
      const parse = vi.spyOn(JSON, 'parse')
      let visits = 0
      const iterator = Map.prototype[Symbol.iterator]
      const walk = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
        this: Map<unknown, unknown>
      ) {
        for (const entry of iterator.call(this)) {
          if (
            entry[1] &&
            typeof entry[1] === 'object' &&
            'sessionId' in entry[1] &&
            'lifecycle' in entry[1]
          ) {
            visits++
          }
          yield entry
        }
        return undefined
      })
      const write = vi.spyOn(localStorage, 'setItem')
      try {
        const loaded = readStructuredAgentLaunchRecords()
        expect(loaded).toHaveLength(size + Number(outer))
        for (let i = 0; i < 10; i++) {
          expect(readStructuredAgentLaunchRecords()).toHaveLength(loaded.length)
        }
        writeStructuredAgentLaunchRecords(loaded)
        expect(parse).toHaveBeenCalledTimes(2)
        expect(write).toHaveBeenCalledTimes(1)
        const expected = 12 * (size + (outer ? 4 : 0))
        expect(visits).toBeLessThanOrEqual(expected)
        counts.push([size, Number(outer), visits])
      } finally {
        parse.mockRestore()
        walk.mockRestore()
        write.mockRestore()
      }
      expect(
        JSON.parse(localStorage.getItem('orca:structuredAgentLaunches:v1') ?? '[]')
      ).toHaveLength(size + Number(outer))
    }
  }
  console.info('canonical load/read/serialize record visits', JSON.stringify(counts))
})
