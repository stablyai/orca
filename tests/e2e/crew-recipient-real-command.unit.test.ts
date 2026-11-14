import { ORCHESTRATION_CREW_METHODS } from '../../src/main/runtime/rpc/methods/orchestration/crew-methods'
import {
  CrewFrame,
  type OrchestrationCrewFrame
} from '../../src/shared/orchestration/orchestration-crew'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as profileStorage from '../../src/main/orca-profiles/profile-storage-paths'
import { randomUUID } from 'node:crypto'

import { releaseAgentSessionRecordStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store-slot'

import { afterEach, expect, it, vi } from 'vitest'

import { createSessionCallerHarness } from '../../src/main/runtime/rpc/orchestration/callers/session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)
afterEach(async () => {
  const remaining = await releaseAgentSessionRecordStore()
  remaining?.journalDatabase.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('publishes a restored session peer in the first completed Crew frame', async () => {
  const fixtureNow = 1_700_000_000_000
  const directory = mkdtempSync(join(tmpdir(), 'orca-restored-crew-'))
  const profilePath = vi.spyOn(profileStorage, 'getProfileUserDataPath').mockReturnValue(directory)
  const h = createSessionCallerHarness({ current: null })
  hostRef.current = null
  const ids = Array.from({ length: 3 }, () => randomUUID())
  const controller = new AbortController()
  let subscription: Promise<void> | undefined
  try {
    const seed = await h.runtime.openAgentSessionRecordStore()
    for (const [i, sessionId] of ids.entries()) {
      await seed.founding.commit({
        sessionId,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'folder-worker-host',
          workspaceKind: 'folder'
        },
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: '/unused-private-fixture-account-home' },
        surfaceTabId: `tab_saved_${i}`,
        expectedFence: null,
        spawnToken: 'unused-at-rest',
        claimKeyId: 'private-cold-claim',
        handoffOperationId: null,
        probe: { outcome: 'indeterminate', reason: 'at-rest creation starts no process' },
        operation: {
          callerKey: 'private-cold',
          operationId: `${fixtureNow}-${randomUUID().replaceAll('-', '')}`,
          fingerprint: `found:${sessionId}`
        },
        now: fixtureNow
      })
    }
    const released = await releaseAgentSessionRecordStore()
    if (!released) {
      throw new Error('Expected fixture-owned seeded slot')
    }
    released.journalDatabase.close()
    h.db.insertMessage({
      from: `orca_session_id:${ids[1]}`,
      to: `orca_session_id:${ids[0]}`,
      subject: 'saved peer',
      body: 'cold L'
    })
    const received: OrchestrationCrewFrame[] = []
    const completed = Promise.withResolvers<void>()
    subscription = ORCHESTRATION_CREW_METHODS[0].handler(
      { party: `orca_session_id:${ids[0]}` },
      { runtime: h.runtime, signal: controller.signal },
      (value) => {
        const frame = CrewFrame.parse(value)
        received.push(frame)
        if (frame.type === 'complete') {
          completed.resolve()
        }
      }
    )
    await completed.promise
    expect(received[0]).toEqual({ type: 'begin', status: 'ok' })
    expect(
      received
        .flatMap((frame) => (frame.type === 'rows' ? frame.rows : []))
        .find((row) => row.latest?.preview === 'cold L')?.sendAddress
    ).toBe(`orca_session_id:${ids[1]}`)
  } finally {
    controller.abort()
    await subscription
    const opened = await releaseAgentSessionRecordStore()
    opened?.journalDatabase.close()
    h.close()
    profilePath.mockRestore()
  }
})
