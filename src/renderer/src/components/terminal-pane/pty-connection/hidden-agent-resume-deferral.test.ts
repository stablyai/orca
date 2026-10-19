import { describe, expect, it, vi } from 'vitest'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const wakeRequests = vi.hoisted(() => ({ take: vi.fn(() => false) }))
vi.mock('@/lib/sleeping-agent-wake-requests', () => ({
  takeSleepingAgentWakeRequest: wakeRequests.take
}))
vi.mock('./deferred-session-reattach-connect', () => ({ startDeferredSessionReattach: vi.fn() }))

import {
  deferHiddenAgentResume,
  noteHiddenAgentResumePtyEnded
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
