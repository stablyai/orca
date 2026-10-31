import { describe, expect, it, vi } from 'vitest'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const wakeRequests = vi.hoisted(() => ({ take: vi.fn(() => false) }))
vi.mock('@/lib/sleeping-agent-wake-requests', () => ({
  takeSleepingAgentWakeRequest: wakeRequests.take
}))
const paneStarts = vi.hoisted(
  (): { byPaneKey: Record<string, { status: string }> } => ({ byPaneKey: {} })
)
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ terminalPaneStartsByPaneKey: paneStarts.byPaneKey })
  }
}))
vi.mock('./deferred-session-reattach-connect', () => ({ startDeferredSessionReattach: vi.fn() }))

import {
  deferHiddenAgentResume,
  noteHiddenAgentResumePtyEnded,
  releaseHiddenAgentResumeHold
} from './hidden-agent-resume-deferral'

function hiddenPaneSession(): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deferHiddenAgentResume reads only these session members.
  return {
    disposed: false,
    cacheKey: 'tab-1:leaf-1',
    deps: { isVisibleRef: { current: false } },
    transport: { getPtyId: () => null },
    hibernatedWakeTarget: null,
    hibernatedWakeInFlightClaimKey: null,
    wakeHibernatedAgentPane: () => Promise.resolve('pty-1')
  } as unknown as ConnectPanePtySession
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deferHiddenAgentResume reads only the record entry.
const startup = {
  sleepingRecordEntry: { paneKey: 'tab-1:leaf-1', record: { paneKey: 'tab-1:leaf-1' } }
} as unknown as ColdRestoreAgentResumeStartup
const startupRecord = startup.sleepingRecordEntry
if (!startupRecord) {
  throw new Error('test startup record is required')
}

describe('deferHiddenAgentResume', () => {
  it('holds again once a pane a background wake released has gone back to sleep', () => {
    const session = hiddenPaneSession()
    wakeRequests.take.mockReturnValueOnce(true)

    expect(deferHiddenAgentResume(session, startup)).toBe(false)
    // A fallback in the same connect keeps the background wake's release.
    expect(deferHiddenAgentResume(session, startup)).toBe(false)

    noteHiddenAgentResumePtyEnded(session)
    expect(deferHiddenAgentResume(session, startup)).toBe(true)
  })

  it('consumes a pending wake mark when a visible or disposed pane bypasses the hidden deferral', async () => {
    const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
    wakeRequests.take.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deferHiddenAgentResume reads only these session members.
    const visible = {
      ...hiddenPaneSession(),
      deps: { isVisibleRef: { current: true } },
      pendingSpawnKey: 'tab-1:leaf-1',
      transportConnectInFlightSince: 1
    } as unknown as ConnectPanePtySession
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deferHiddenAgentResume reads only these session members.
    const disposed = {
      ...hiddenPaneSession(),
      disposed: true
    } as unknown as ConnectPanePtySession

    expect(deferHiddenAgentResume(visible, startup)).toBe(false)
    expect(deferHiddenAgentResume(disposed, startup)).toBe(false)
    // A pane that never takes the deferral path must not leave its mark behind as stale ownership.
    expect(wakeRequests.take).toHaveBeenCalledWith(startupRecord.record)
    expect(wakeRequests.take).toHaveBeenCalledTimes(2)
    expect(deferHiddenAgentResume(visible, null)).toBe(false)
    expect(wakeRequests.take).toHaveBeenCalledTimes(2)
    // The visible pane keeps attempt-scoped ownership while its restore is in flight…
    expect(isPaneSpawnDeferred('tab-1:leaf-1')).toBe(true)
    // …through main's start handoff too: no renderer connect or spawn pending, but main's start of
    // the pane is in flight, and the sweep must not fork a duplicate across that window.
    visible.transportConnectInFlightSince = null
    paneStarts.byPaneKey = { 'tab-1:leaf-1': { status: 'starting' } }
    expect(isPaneSpawnDeferred('tab-1:leaf-1')).toBe(true)
    // Once everything settles the hold reads false and self-releases (one attempt, one hold).
    paneStarts.byPaneKey = {}
    expect(isPaneSpawnDeferred('tab-1:leaf-1')).toBe(false)
    // A pane disposed mid-attempt releases a re-armed hold through the shared disposal path, so
    // the registry entry cannot pin the pane's session graph until its pane key is reused.
    visible.transportConnectInFlightSince = 1
    expect(deferHiddenAgentResume(visible, startup)).toBe(false)
    expect(isPaneSpawnDeferred('tab-1:leaf-1')).toBe(true)
    visible.disposed = true
    releaseHiddenAgentResumeHold(visible)
    expect(isPaneSpawnDeferred('tab-1:leaf-1')).toBe(false)
  })

  it('preserves a wake consumed by a visible bypass through a later hidden fallback', () => {
    const session = hiddenPaneSession()
    session.deps.isVisibleRef.current = true
    wakeRequests.take.mockClear()
    wakeRequests.take.mockReturnValueOnce(true)

    expect(deferHiddenAgentResume(session, startup)).toBe(false)
    expect(session.hiddenAgentResumeReleased).toBe(true)

    session.deps.isVisibleRef.current = false
    wakeRequests.take.mockReturnValue(false)
    expect(deferHiddenAgentResume(session, startup)).toBe(false)
    expect(wakeRequests.take).toHaveBeenCalledTimes(1)

    noteHiddenAgentResumePtyEnded(session)
    expect(deferHiddenAgentResume(session, startup)).toBe(true)
  })

  it('releases the hold under a record key the pane no longer holds', async () => {
    const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
    const session = hiddenPaneSession()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deferHiddenAgentResume reads only the record entry.
    const legacyStartup = {
      sleepingRecordEntry: { paneKey: 'tab-1:2', record: { paneKey: 'tab-1:2' } }
    } as unknown as ColdRestoreAgentResumeStartup

    expect(deferHiddenAgentResume(session, legacyStartup)).toBe(true)
    expect(isPaneSpawnDeferred('tab-1:2')).toBe(true)
    expect(deferHiddenAgentResume(session, startup)).toBe(true)

    expect(isPaneSpawnDeferred('tab-1:2')).toBe(false)
    expect(isPaneSpawnDeferred('tab-1:leaf-1')).toBe(true)
  })
})
