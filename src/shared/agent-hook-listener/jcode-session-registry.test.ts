import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => {
  // oxlint-disable-next-line typescript/consistent-type-imports -- vi.importActual types the real module
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, openSync: vi.fn(actual.openSync) }
})
import {
  bindJcodeRootSession,
  bindJcodeWorkerSession,
  clearJcodePaneSessions,
  closeJcodeSession,
  commitJcodeSessionResolution,
  lookupJcodeSessionBinding,
  moveJcodePaneSessions,
  resolveJcodeSessionEvent,
  takeResolvedJcodeEvents
} from './jcode-session-registry'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  clearPaneTurnCacheState,
  createHookListenerState,
  movePaneCacheState,
  paneHasStateClaims,
  type HookListenerState
} from './listener-state'

// Selected Jcode 0.99.0 captures; generated ids/changes below are negative controls.
const rootId = 'session_tigress_1792603131095_636843aadc1b740b'
const workerId = 'session_retriever_1792603161400_81ad62e08be2201b'
const pigletId = 'session_piglet_1792604760697_211acdce5650ace5'
const bonehoundId = 'session_bonehound_1792604760755_aecccf6c235843ea'
const workerStart = {
  cwd: '/tmp/jcapt-cwd',
  event: 'turn_start',
  model: 'claude-haiku-5-5',
  session_id: workerId,
  source: 'chat'
}
const bonehoundStart = {
  cwd: '/tmp/jcapt-cwd',
  event: 'session_start',
  model: 'claude-opus-5-5',
  session_id: bonehoundId,
  source: 'create'
}
const bonehoundClose = { ...bonehoundStart, event: 'session_end', source: 'close' }
const pane = 'tab:00000000-0000-4000-8000-000000000001'
const movedPane = 'moved:00000000-0000-4000-8000-000000000002'

describe('listener-local Jcode ownership', () => {
  let home: string
  let state: HookListenerState

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    home = mkdtempSync(join(tmpdir(), 'orca-jcode-registry-'))
    mkdirSync(join(home, 'sessions'))
    vi.stubEnv('JCODE_HOME', home)
    state = createHookListenerState()
    vi.mocked(openSync).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  function document(id: string, parent: string | null, status = 'Active'): void {
    writeFileSync(
      join(home, 'sessions', `${id}.json`),
      JSON.stringify({
        id,
        parent_id: parent,
        short_name: id.split('_')[1],
        status
      })
    )
  }

  function input(payload: Record<string, unknown>, receivedAt = 0, key = pane) {
    return {
      body: { paneKey: key, tabId: key.split(':')[0], launchToken: 'original-launch', payload },
      receivedAt,
      isReplay: true
    }
  }

  function accept(payload: Record<string, unknown>, now = 0, key = pane) {
    const transport = input(payload, now, key)
    const result = resolveJcodeSessionEvent(
      state,
      key,
      String(payload.event),
      payload,
      now,
      transport
    )
    commitJcodeSessionResolution(state, result)
    return { result, transport }
  }

  function overflow(key = pane): void {
    for (let i = 0; i < 1001; i++) {
      closeJcodeSession(state, key, `closed_${i}`)
    }
  }

  function expectInputs(key: string, now: number, expected: ReturnType<typeof input>[]): void {
    const selected = takeResolvedJcodeEvents(state, key, now)
    expect(selected).toHaveLength(expected.length)
    expected.forEach((original, index) => expect(selected[index]).toBe(original))
  }

  it('buffers worker-first only after commit, then releases its exact original envelope', () => {
    document(workerId, rootId)
    const transport = input(workerStart)
    expect(
      resolveJcodeSessionEvent(state, pane, 'turn_start', workerStart, 0, transport).kind
    ).toBe('pending')
    expect(takeResolvedJcodeEvents(state, pane, 250)).toEqual([])
    const pending = resolveJcodeSessionEvent(state, pane, 'turn_start', workerStart, 0, transport)
    commitJcodeSessionResolution(state, pending)
    expect(bindJcodeRootSession(state, pane, rootId, 'launch')).toBe(true)
    expectInputs(pane, 250, [transport])
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.role).toBe('root')
    const worker = resolveJcodeSessionEvent(state, pane, 'turn_start', workerStart, 250, transport)
    expect(worker.kind).toBe('worker')
    expect(lookupJcodeSessionBinding(state, pane, workerId)).toBeUndefined()
    commitJcodeSessionResolution(state, worker)
    expect(lookupJcodeSessionBinding(state, pane, workerId)).toMatchObject({
      role: 'worker',
      rootSessionId: rootId
    })
    expect(takeResolvedJcodeEvents(state, pane, 250)).toEqual([])
  })

  it('payload-only pending calls never retain queue evidence', () => {
    document(workerId, rootId)
    const pending = resolveJcodeSessionEvent(state, pane, 'turn_start', workerStart, 0)
    expect(pending.kind).toBe('pending')
    commitJcodeSessionResolution(state, pending)
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expect(takeResolvedJcodeEvents(state, pane, 250)).toEqual([])
  })

  it('adopts first readable explicit-null root without replacing it with another parentless session', () => {
    document(rootId, null)
    document(pigletId, null)
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('root')
    expect(
      accept({ session_id: pigletId, event: 'session_start', source: 'resume' }).result.kind
    ).toBe('ignored')
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.basis).toBe('session-file')
    expect(lookupJcodeSessionBinding(state, pane, pigletId)).toBeUndefined()
  })

  it('trusted launch works before files exist and alone can replace a live root', () => {
    expect(bindJcodeRootSession(state, pane, rootId, 'launch')).toBe(true)
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('root')
    expect(bindJcodeRootSession(state, pane, pigletId, 'session-file')).toBe(false)
    expect(bindJcodeRootSession(state, pane, pigletId, 'launch')).toBe(true)
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    expect(accept({ session_id: rootId, event: 'turn_start' }, 1000).result.kind).toBe('ignored')
  })

  it('readable session end resolves even when its earlier hooks were absent', () => {
    document(rootId, null)
    expect(accept({ session_id: rootId, event: 'session_end' }).result.kind).toBe('root')
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('ignored')
  })

  it('explicit launch remains authoritative over a stale closed session document', () => {
    document(rootId, null, 'Closed')
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('root')
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.basis).toBe('launch')
  })

  it('no-file bonehound create/close leaves neither binding nor replayable input', () => {
    expect(accept(bonehoundStart).result.kind).toBe('pending')
    expect(accept(bonehoundClose, 1).result.kind).toBe('ignored')
    document(bonehoundId, null)
    expect(accept({ ...bonehoundStart, event: 'turn_start' }, 1000).result.kind).toBe('ignored')
    expect(lookupJcodeSessionBinding(state, pane, bonehoundId)).toBeUndefined()
    expect(takeResolvedJcodeEvents(state, pane, 1000)).toEqual([])
    expect(paneHasStateClaims(state, pane)).toBe(true)
  })

  it('closing unknown bonehound leaves the known root queue intact', () => {
    const root = accept({ session_id: rootId, event: 'turn_start' }).transport
    bindJcodeRootSession(state, pane, rootId, 'launch')
    accept(bonehoundStart)
    accept(bonehoundClose, 1)
    expectInputs(pane, 250, [root])
  })

  it('closing an unseen id ignores late turn_start replay without buffering or root adoption', () => {
    closeJcodeSession(state, pane, rootId)
    const payload = { session_id: rootId, event: 'turn_start' }
    expect(accept(payload).result.kind).toBe('ignored')
    expect(state.jcodeSessions.pending).toHaveLength(0)
    document(rootId, null)
    expect(accept(payload, 1000).result.kind).toBe('ignored')
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    expect(takeResolvedJcodeEvents(state, pane, 1000)).toEqual([])
    expect(state.jcodeSessions.pending).toHaveLength(0)
  })

  it('root close retires workers still buffered before binding', () => {
    document(workerId, rootId)
    accept(workerStart)
    bindJcodeRootSession(state, pane, rootId, 'launch')
    closeJcodeSession(state, pane, rootId)
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expect(takeResolvedJcodeEvents(state, pane, 250)).toEqual([])
    expect(accept(workerStart, 250).result.kind).toBe('ignored')
  })

  it('requires actual parent evidence and rejects a worker belonging to another root', () => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    document(workerId, 'session_foreign')
    expect(accept(workerStart).result.kind).toBe('ignored')
    expect(lookupJcodeSessionBinding(state, pane, workerId)).toBeUndefined()
    expect(accept({ ...workerStart, session_id: bonehoundId, source: 'create' }).result.kind).toBe(
      'pending'
    )
  })

  it('explicit spawn binding accepts null-parent piglet and rejects conflicting roots/roles', () => {
    document(pigletId, null)
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expect(bindJcodeWorkerSession(state, pane, rootId, pigletId, 'session-file')).toBe(false)
    expect(bindJcodeWorkerSession(state, pane, rootId, pigletId, 'spawn-hook')).toBe(true)
    expect(bindJcodeWorkerSession(state, pane, 'session_foreign', pigletId, 'spawn-hook')).toBe(
      false
    )
    expect(bindJcodeWorkerSession(state, pane, rootId, rootId, 'spawn-hook')).toBe(false)
    expect(bindJcodeRootSession(state, pane, pigletId, 'session-file')).toBe(false)
    expect(accept({ session_id: pigletId, event: 'turn_start' }).result.kind).toBe('worker')
  })

  it('isolates listener instances and panes even with identical session ids', () => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expect(lookupJcodeSessionBinding(createHookListenerState(), pane, rootId)).toBeUndefined()
    expect(lookupJcodeSessionBinding(state, movedPane, rootId)).toBeUndefined()
  })

  it('resolution_does_not_mutate_until_committed', () => {
    const previous = state.jcodeSessions
    const old = resolveJcodeSessionEvent(state, pane, 'session_end', { session_id: rootId }, 0)
    expect(state.jcodeSessions).toBe(previous)
    document(rootId, null)
    // Rejected close must leave neither negative cache nor tombstone.
    const fresh = resolveJcodeSessionEvent(state, pane, 'turn_start', { session_id: rootId }, 1)
    expect(fresh.kind).toBe('root')
    expect(state.jcodeSessions).toEqual(previous)
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    commitJcodeSessionResolution(state, fresh)
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.role).toBe('root')
    // A stale prepared close cannot undo a newer accepted binding.
    commitJcodeSessionResolution(state, old)
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.role).toBe('root')
  })

  it('reselection and rejected drain do not consume any input; accepted delivery removes exactly once', () => {
    document(workerId, rootId)
    const first = accept(workerStart, 0).transport
    const second = accept({ ...workerStart, event: 'turn_end' }, 1).transport
    bindJcodeRootSession(state, pane, rootId, 'launch')
    const selected = takeResolvedJcodeEvents(state, pane, 250)
    expect(selected).toHaveLength(2)
    expect(selected[0]).toBe(first)
    expect(selected[1]).toBe(second)
    resolveJcodeSessionEvent(state, pane, 'turn_start', workerStart, 250, first)
    expectInputs(pane, 250, [first, second])
    const accepted = resolveJcodeSessionEvent(state, pane, 'turn_start', workerStart, 250, first)
    commitJcodeSessionResolution(state, accepted)
    commitJcodeSessionResolution(state, accepted)
    expectInputs(pane, 250, [second])
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.sessionId).toBe(rootId)
  })

  it('retains root envelopes independently of whichever worker triggers retry', () => {
    const rootPayload = { session_id: rootId, event: 'turn_start' }
    const rootInput = input(rootPayload)
    const pending = resolveJcodeSessionEvent(state, pane, 'turn_start', rootPayload, 0, rootInput)
    commitJcodeSessionResolution(state, pending)
    document(rootId, null)
    document(workerId, rootId)
    expect(takeResolvedJcodeEvents(state, pane, 249)).toEqual([])
    expectInputs(pane, 250, [rootInput])
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    expect(rootInput.body.launchToken).toBe('original-launch')
  })

  it('closes worker alone, then root and all its workers, fencing late events', () => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    bindJcodeWorkerSession(state, pane, rootId, workerId, 'spawn-hook')
    bindJcodeWorkerSession(state, pane, rootId, pigletId, 'spawn-hook')
    closeJcodeSession(state, pane, workerId)
    expect(accept(workerStart).result.kind).toBe('ignored')
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.role).toBe('root')
    expect(accept({ session_id: rootId, event: 'session_end' }).result.kind).toBe('root')
    document(rootId, null)
    document(pigletId, rootId)
    expect(accept({ session_id: rootId, event: 'turn_start' }, 1000).result.kind).toBe('ignored')
    expect(accept({ session_id: pigletId, event: 'turn_start' }, 1000).result.kind).toBe('ignored')
    expect(lookupJcodeSessionBinding(state, pane, pigletId)).toBeUndefined()
  })

  it('closed metadata never establishes ownership', () => {
    document(rootId, null, 'Closed')
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('ignored')
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    expect(state.jcodeSessions.tombstones.size).toBe(0)
    document(rootId, null)
    expect(
      accept({ ...bonehoundStart, session_id: rootId, source: 'resume' }, 1000).result.kind
    ).toBe('root')
  })

  it.each(['create', 'resume'])('re-adopts a closed root only on a readable %s start', (source) => {
    document(rootId, null)
    accept({ session_id: rootId, event: 'turn_start' })
    accept({ session_id: rootId, event: 'session_end' })
    expect(accept({ session_id: rootId, event: 'post_tool' }).result.kind).toBe('ignored')
    expect(accept({ ...bonehoundStart, session_id: rootId, source }).result.kind).toBe('root')
    expect(state.jcodeSessions.tombstones.size).toBe(0)
  })

  it.each(['Closed', 'worker', 'missing', 'other-source'])(
    'keeps tombstoned %s sessions fenced at session_start',
    (condition) => {
      // Negative controls: invalid re-adoption evidence must not lift the close fence.
      closeJcodeSession(state, pane, rootId)
      if (condition !== 'missing') {
        document(rootId, condition === 'worker' ? workerId : null, condition)
      }
      expect(
        accept({
          ...bonehoundStart,
          session_id: rootId,
          source: condition === 'other-source' ? 'chat' : 'resume'
        }).result.kind
      ).toBe('ignored')
      expect(state.jcodeSessions.tombstones.size).toBe(1)
    }
  )

  describe('resume hook dispatched before Jcode persists the session', () => {
    const resume = { ...bonehoundStart, session_id: rootId, source: 'resume' }

    function tombstoneRoot(): void {
      document(rootId, null)
      accept({ session_id: rootId, event: 'turn_start' })
      accept({ session_id: rootId, event: 'session_end' })
      document(rootId, null, 'Closed')
    }

    it('adopts the session at the first hook that reads Active metadata', () => {
      tombstoneRoot()
      expect(accept(resume, 0).result.kind).toBe('ignored')
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 2000).result.kind).toBe('root')
      expect(state.jcodeSessions.tombstones.size).toBe(0)
      expect(accept({ session_id: rootId, event: 'post_tool' }, 2001).result.kind).toBe('root')
    })

    it('adopts a retired bound root whose resume hook read stale Closed metadata', () => {
      document(rootId, null)
      accept({ session_id: rootId, event: 'turn_start' })
      document(rootId, null, 'Closed')
      expect(accept(resume, 2000).result.kind).toBe('ignored')
      expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 4000).result.kind).toBe('root')
    })

    it('keeps the close fence for a Closed session that sent no resume', () => {
      tombstoneRoot()
      expect(accept({ session_id: rootId, event: 'post_tool' }, 0).result.kind).toBe('ignored')
      expect(accept({ ...resume, source: 'create' }, 0).result.kind).toBe('ignored')
      expect(accept({ ...resume, source: 'chat' }, 0).result.kind).toBe('ignored')
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 2000).result.kind).toBe('ignored')
      expect(state.jcodeSessions.tombstones.size).toBe(1)
    })

    it('keeps the fence while the metadata stays Closed, unreadable or non-root', () => {
      tombstoneRoot()
      accept(resume, 0)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 2000).result.kind).toBe('ignored')
      document(rootId, workerId)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 4000).result.kind).toBe('ignored')
      rmSync(join(home, 'sessions', `${rootId}.json`))
      expect(accept({ session_id: rootId, event: 'turn_start' }, 6000).result.kind).toBe('ignored')
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 8000).result.kind).toBe('root')
    })

    it('records nothing for an unreadable or non-root resume document', () => {
      closeJcodeSession(state, pane, rootId)
      accept(resume, 0)
      document(rootId, workerId, 'Closed')
      accept(resume, 2000)
      expect(state.jcodeSessions.resumes.size).toBe(0)
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 4000).result.kind).toBe('ignored')
    })

    it('forgets the evidence after exactly the pending window', () => {
      tombstoneRoot()
      accept(resume, 0)
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 30_000).result.kind).toBe(
        'ignored'
      )
      expect(state.jcodeSessions.resumes.size).toBe(0)
    })

    it('still adopts one millisecond before the window closes', () => {
      tombstoneRoot()
      accept(resume, 0)
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 29_999).result.kind).toBe('root')
    })

    it.each(['session_end', 'teardown', 'pane clear'])('drops the evidence on %s', (how) => {
      tombstoneRoot()
      accept(resume, 0)
      expect(state.jcodeSessions.resumes.size).toBe(1)
      if (how === 'session_end') {
        accept({ session_id: rootId, event: 'session_end' }, 1)
      } else if (how === 'teardown') {
        closeJcodeSession(state, pane, rootId)
      } else {
        clearJcodePaneSessions(state, pane)
      }
      expect(state.jcodeSessions.resumes.size).toBe(0)
      document(rootId, null)
      // A pane clear lifts the whole fence, so only the other two prove the resume is gone.
      expect(accept({ session_id: rootId, event: 'turn_start' }, 2000).result.kind).toBe(
        how === 'pane clear' ? 'root' : 'ignored'
      )
    })

    it('never displaces a live root', () => {
      closeJcodeSession(state, pane, rootId)
      document(rootId, null, 'Closed')
      accept(resume, 0)
      bindJcodeRootSession(state, pane, pigletId, 'launch')
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 2000).result.kind).toBe('ignored')
      expect(lookupJcodeSessionBinding(state, pane, pigletId)?.role).toBe('root')
      expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
      expect(state.jcodeSessions.tombstones.size).toBe(1)
    })

    it('keeps one entry per session and moves it with its pane', () => {
      tombstoneRoot()
      accept(resume, 0)
      accept(resume, 1)
      accept({ ...resume, session_id: pigletId }, 2)
      expect(state.jcodeSessions.resumes.size).toBe(1)
      moveJcodePaneSessions(state, pane, movedPane)
      document(rootId, null)
      expect(accept({ session_id: rootId, event: 'turn_start' }, 2000, movedPane).result.kind).toBe(
        'root'
      )
    })
  })

  it.each(['binding', 'tombstone'])('exit cleanup sees a rowless %s claim', (claim) => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    if (claim === 'tombstone') {
      closeJcodeSession(state, pane, rootId)
    }
    expect(paneHasStateClaims(state, pane)).toBe(true)
    clearPaneCacheState(state, pane)
    expect(paneHasStateClaims(state, pane)).toBe(false)
  })

  it('expires pending input at exactly 30 seconds, not one ms before', () => {
    const pending = accept(workerStart).transport
    document(workerId, rootId)
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expectInputs(pane, 29_999, [pending])
    expect(takeResolvedJcodeEvents(state, pane, 30_000)).toEqual([])
  })

  it('bounds queue to 32 per pane, evicting oldest first', () => {
    const inputs = Array.from({ length: 33 }, (_, i) => accept(workerStart, i).transport)
    document(workerId, rootId)
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expectInputs(pane, 250, inputs.slice(1))
  })

  it('bounds queue to 128 listener-wide, evicting oldest across panes', () => {
    const inputs = Array.from(
      { length: 129 },
      (_, i) => accept(workerStart, i, `pane-${i % 5}`).transport
    )
    document(workerId, rootId)
    for (let i = 0; i < 5; i++) {
      bindJcodeRootSession(state, `pane-${i}`, rootId, 'launch')
    }
    const retained = Array.from({ length: 5 }, (_, i) =>
      takeResolvedJcodeEvents(state, `pane-${i}`, 250)
    ).flat()
    expect(retained).toHaveLength(128)
    for (let i = 0; i < 5; i++) {
      expectInputs(
        `pane-${i}`,
        250,
        inputs.slice(1).filter((entry) => entry.body.paneKey === `pane-${i}`)
      )
    }
  })

  it('bounds serialized queue bytes and drops unserializable or oversized evidence', () => {
    const big = { ...workerStart, padding: 'x'.repeat(150 * 1024) }
    accept(big, 0)
    const last = accept(big, 1).transport
    accept({ ...workerStart, padding: 'x'.repeat(256 * 1024) }, 2)
    accept({ ...workerStart, padding: 1n }, 3)
    document(workerId, rootId)
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expectInputs(pane, 250, [last])
  })

  it('refuses capacity overflow without evicting active owners', () => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    for (let i = 0; i < 999; i++) {
      expect(bindJcodeWorkerSession(state, pane, rootId, `worker_${i}`, 'spawn-hook')).toBe(true)
    }
    expect(bindJcodeWorkerSession(state, pane, rootId, workerId, 'spawn-hook')).toBe(false)
    expect(bindJcodeRootSession(state, movedPane, pigletId, 'launch')).toBe(false)
    expect(lookupJcodeSessionBinding(state, pane, 'worker_0')?.role).toBe('worker')
    closeJcodeSession(state, pane, 'worker_0')
    expect(bindJcodeWorkerSession(state, pane, rootId, workerId, 'spawn-hook')).toBe(true)
  })

  it('tombstone pressure discards new unknown sessions rather than resurrecting closed ids', () => {
    overflow()
    const original = state.jcodeSessions
    closeJcodeSession(state, pane, 'another_closed_id')
    expect(state.jcodeSessions).toBe(original)
    document('closed_1000', null)
    expect(accept({ session_id: 'closed_1000', event: 'turn_start' }).result.kind).toBe('ignored')
    document(rootId, null)
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('ignored')
    expect(bindJcodeRootSession(state, pane, rootId, 'launch')).toBe(true)
  })

  it('overflow refuses workers and file adoption on that pane but leaves other panes usable', () => {
    overflow()
    document(rootId, null)
    document(workerId, rootId)
    expect(bindJcodeRootSession(state, pane, rootId, 'session-file')).toBe(false)
    expect(bindJcodeRootSession(state, pane, rootId, 'launch')).toBe(true)
    expect(bindJcodeWorkerSession(state, pane, rootId, workerId, 'spawn-hook')).toBe(false)
    expect(accept(workerStart).result.kind).toBe('ignored')
    expect(bindJcodeRootSession(state, movedPane, rootId, 'session-file')).toBe(true)
    expect(bindJcodeWorkerSession(state, movedPane, rootId, workerId, 'spawn-hook')).toBe(true)
  })

  it('clearing the overflowed pane lifts its fence', () => {
    overflow()
    clearJcodePaneSessions(state, pane)
    document(rootId, null)
    document(workerId, rootId)
    expect(bindJcodeRootSession(state, pane, rootId, 'session-file')).toBe(true)
    expect(bindJcodeWorkerSession(state, pane, rootId, workerId, 'spawn-hook')).toBe(true)
  })

  it('overflow fence moves with pane and clears at its new location', () => {
    overflow()
    moveJcodePaneSessions(state, pane, movedPane)
    document(rootId, null)
    expect(accept({ session_id: rootId, event: 'turn_start' }, 0, movedPane).result.kind).toBe(
      'ignored'
    )
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('root')
    clearJcodePaneSessions(state, movedPane)
    expect(accept({ session_id: rootId, event: 'turn_start' }, 0, movedPane).result.kind).toBe(
      'root'
    )
  })

  it('repeated close preserves identity and in-flight resolution', () => {
    closeJcodeSession(state, movedPane, rootId)
    document(rootId, null)
    const prepared = resolveJcodeSessionEvent(state, pane, 'turn_start', { session_id: rootId }, 0)
    const original = state.jcodeSessions
    closeJcodeSession(state, movedPane, rootId)
    expect(state.jcodeSessions).toBe(original)
    commitJcodeSessionResolution(state, prepared)
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.role).toBe('root')
  })

  it('unmatched pane cleanup alone preserves prepared resolution identity', () => {
    document(rootId, null)
    const prepared = resolveJcodeSessionEvent(state, pane, 'turn_start', { session_id: rootId }, 0)
    const original = state.jcodeSessions
    clearJcodePaneSessions(state, movedPane)
    expect(state.jcodeSessions).toBe(original)
    commitJcodeSessionResolution(state, prepared)
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.role).toBe('root')
  })

  it('retiring one session preserves another session negative-cache deadline', () => {
    accept(workerStart)
    bindJcodeRootSession(state, movedPane, rootId, 'launch')
    closeJcodeSession(state, movedPane, rootId)
    document(workerId, null)
    expect(accept(workerStart, 249).result.kind).toBe('pending')
    expect(accept(workerStart, 250).result.kind).toBe('root')
  })

  it.each([
    { body: {}, destination: movedPane, expected: {} },
    { body: { paneKey: pane }, destination: movedPane, expected: { paneKey: movedPane } },
    { body: { tabId: 'tab' }, destination: movedPane, expected: { tabId: 'moved' } },
    {
      body: { paneKey: pane, tabId: 'tab' },
      destination: 'malformed',
      expected: { paneKey: 'malformed', tabId: 'tab' }
    }
  ])('move rewrites only existing envelope keys: %j', ({ body, destination, expected }) => {
    const transport = { body, receivedAt: 0 }
    commitJcodeSessionResolution(
      state,
      resolveJcodeSessionEvent(state, pane, 'turn_start', workerStart, 0, transport)
    )
    moveJcodePaneSessions(state, pane, destination)
    document(workerId, rootId)
    bindJcodeRootSession(state, destination, rootId, 'launch')
    const selected = takeResolvedJcodeEvents(state, destination, 250)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.body).toEqual(expected)
    expect(transport.body).toBe(body)
  })

  it('move reports success and collision refusal through one public rule', () => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expect(moveJcodePaneSessions(state, pane, movedPane)).toBe(true)
    expect(moveJcodePaneSessions(state, movedPane, movedPane)).toBe(true)
    bindJcodeRootSession(state, pane, pigletId, 'launch')
    expect(moveJcodePaneSessions(state, movedPane, pane)).toBe(false)
  })

  it.each(['../../escape', 'bad/id', '', 'x'.repeat(513)])(
    'rejects unsafe ids without touching session storage: %s',
    (id) => {
      const previous = state.jcodeSessions
      expect(accept({ session_id: id, event: 'turn_start' }).result.kind).toBe('ignored')
      expect(bindJcodeRootSession(state, pane, id, 'launch')).toBe(false)
      expect(lookupJcodeSessionBinding(state, pane, id)).toBeUndefined()
      expect(state.jcodeSessions).toEqual(previous)
      expect(openSync).not.toHaveBeenCalled()
    }
  )

  it('moves bindings and queued envelope pane keys without mutating original inputs', () => {
    const original = accept(workerStart).transport
    bindJcodeRootSession(state, pane, rootId, 'launch')
    closeJcodeSession(state, pane, bonehoundId)
    moveJcodePaneSessions(state, pane, movedPane)
    document(workerId, rootId)
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    expect(lookupJcodeSessionBinding(state, movedPane, rootId)?.paneKey).toBe(movedPane)
    const selected = takeResolvedJcodeEvents(state, movedPane, 250)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.body).toMatchObject({
      paneKey: movedPane,
      tabId: 'moved',
      launchToken: 'original-launch'
    })
    expect(original.body.paneKey).toBe(pane)
    document(bonehoundId, null)
    expect(accept({ ...bonehoundStart, event: 'turn_start' }, 1000, movedPane).result.kind).toBe(
      'ignored'
    )
  })

  it('keeps colliding Jcode roots while moving Claude caches', () => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    bindJcodeRootSession(state, movedPane, pigletId, 'launch')
    state.lastPromptByPaneKey.set(pane, 'keep source')
    state.lastPromptByPaneKey.set(movedPane, 'keep target')
    state.claudeSessionOwnerByPaneKey.set(pane, 'claude-session')
    const sourceTurn = { sessionId: rootId, revision: 1, active: true, lastActivityAt: 0 }
    const targetTurn = { ...sourceTurn, sessionId: pigletId, revision: 2 }
    state.jcodeTurnByPaneKey.set(pane, sourceTurn)
    state.jcodeTurnByPaneKey.set(movedPane, targetTurn)
    movePaneCacheState(state, pane, movedPane)
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.paneKey).toBe(pane)
    expect(lookupJcodeSessionBinding(state, movedPane, pigletId)?.paneKey).toBe(movedPane)
    expect(state.lastPromptByPaneKey.has(pane)).toBe(false)
    expect(state.lastPromptByPaneKey.get(movedPane)).toBe('keep source')
    expect(state.claudeSessionOwnerByPaneKey.has(pane)).toBe(false)
    expect(state.claudeSessionOwnerByPaneKey.get(movedPane)).toBe('claude-session')
    expect(state.jcodeTurnByPaneKey.get(pane)).toBe(sourceTurn)
    expect(state.jcodeTurnByPaneKey.get(movedPane)).toBe(targetTurn)
  })

  it('does not move closed-session evidence onto an unrelated live root', () => {
    closeJcodeSession(state, pane, rootId)
    bindJcodeRootSession(state, movedPane, rootId, 'launch')
    moveJcodePaneSessions(state, pane, movedPane)
    expect(accept({ session_id: rootId, event: 'turn_start' }, 0, movedPane).result.kind).toBe(
      'root'
    )
    document(rootId, null)
    expect(accept({ session_id: rootId, event: 'turn_start' }, 1000, pane).result.kind).toBe(
      'ignored'
    )
  })

  it('lifecycle preserves ownership across turn clear, moves it, and clears pane/all state', () => {
    bindJcodeRootSession(state, pane, rootId, 'launch')
    expect(paneHasStateClaims(state, pane)).toBe(true)
    clearPaneTurnCacheState(state, pane)
    expect(lookupJcodeSessionBinding(state, pane, rootId)?.role).toBe('root')
    movePaneCacheState(state, pane, movedPane)
    expect(lookupJcodeSessionBinding(state, movedPane, rootId)?.paneKey).toBe(movedPane)
    clearPaneCacheState(state, movedPane)
    expect(lookupJcodeSessionBinding(state, movedPane, rootId)).toBeUndefined()
    closeJcodeSession(state, pane, rootId)
    clearJcodePaneSessions(state, pane)
    document(rootId, null)
    expect(accept({ session_id: rootId, event: 'turn_start' }).result.kind).toBe('root')
    accept(workerStart)
    clearAllListenerCaches(state)
    expect(lookupJcodeSessionBinding(state, pane, rootId)).toBeUndefined()
    expect(takeResolvedJcodeEvents(state, pane, 250)).toEqual([])
  })
})
