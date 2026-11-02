import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import {
  dispatchSavedRestoreFreshNotice,
  installSavedRestoreFreshNotice,
  type SavedRestoreFreshNotice
} from './saved-restore-fresh-notice'

const LEAF = '6c1f4e0a-8a1b-4d2a-9c3e-5b7d9e1f2a3b'
const sessions: ConnectPanePtySession[] = []
let dispatchSeq = 0

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.waitTeardowns.forEach((teardown: () => void) => teardown())
  }
})

function pane(boundPtyId: string | null, incarnationId: string | null = 'inc-1') {
  const transport = { getPtyId: () => session.boundPtyId }
  const session = {
    disposed: false,
    boundPtyId,
    remotePtyIncarnationId: incarnationId,
    launchToken: 'token-1',
    waitTeardowns: [],
    pane: { id: 2, leafId: LEAF },
    transport,
    deps: {
      paneTransportsRef: { current: new Map([[2, transport]]) },
      onShowSessionRestoredBanner: vi.fn()
    }
  } as unknown as ConnectPanePtySession
  installSavedRestoreFreshNotice(session)
  sessions.push(session)
  return session
}

function notice(overrides: Partial<SavedRestoreFreshNotice> = {}): SavedRestoreFreshNotice {
  dispatchSeq += 1
  return {
    paneKey: `host-tab:${LEAF}`,
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    launchToken: 'token-1',
    dispatchId: `dispatch-${dispatchSeq}`,
    ...overrides
  }
}

describe('saved-restore fresh-start notice', () => {
  it('shows the existing overlay once for the bound process, however often it is delivered', () => {
    const session = pane('pty-1')
    const event = notice()
    dispatchSavedRestoreFreshNotice(event)
    dispatchSavedRestoreFreshNotice(event)
    dispatchSavedRestoreFreshNotice({ ...event })
    expect(session.deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(session.deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'resume-unavailable')
  })

  it('ignores another pane, process, incarnation or launch', () => {
    const session = pane('pty-1')
    dispatchSavedRestoreFreshNotice(
      notice({ paneKey: 'host-tab:7d2e5f1b-9b2c-4e3b-8d4f-6c8e0f2a3b4c' })
    )
    dispatchSavedRestoreFreshNotice(notice({ ptyId: 'pty-2' }))
    dispatchSavedRestoreFreshNotice(notice({ incarnationId: 'inc-0' }))
    dispatchSavedRestoreFreshNotice(notice({ launchToken: 'token-0' }))
    expect(session.deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('holds a notice that beats its create reply for that new process only', () => {
    const created = pane(null)
    dispatchSavedRestoreFreshNotice(notice())
    expect(created.deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
    created.settleSavedRestoreFreshNotice('pty-1')
    expect(created.deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)

    const adopted = pane(null)
    dispatchSavedRestoreFreshNotice(notice())
    // A reattached or adopted reply settles with no created process.
    adopted.settleSavedRestoreFreshNotice(null)
    adopted.settleSavedRestoreFreshNotice('pty-1')
    expect(adopted.deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('never replays to a pane that mounts or reattaches after the event', () => {
    const event = notice()
    dispatchSavedRestoreFreshNotice(event)
    const reattached = pane('pty-1')
    reattached.settleSavedRestoreFreshNotice(null)
    expect(reattached.deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('stays quiet once the pane is disposed or its transport replaced', () => {
    const disposed = pane('pty-1')
    disposed.disposed = true
    const replaced = pane('pty-1')
    replaced.deps.paneTransportsRef.current.set(2, disposed.transport)
    dispatchSavedRestoreFreshNotice(notice())
    expect(disposed.deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
    expect(replaced.deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
  })
})
