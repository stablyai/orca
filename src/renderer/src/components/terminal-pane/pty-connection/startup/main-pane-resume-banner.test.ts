import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { showMainPaneResumeOutcome as ShowOutcome } from '../spawn/main-pane-resume-banner'

type Outcomes = Record<string, TerminalPaneResumeOutcome>
type StoreState = {
  terminalPaneResumeOutcomesByPaneKey: Outcomes
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
}

const store = vi.hoisted(() => {
  let state: StoreState = { terminalPaneResumeOutcomesByPaneKey: {}, terminalLayoutsByTabId: {} }
  const listeners = new Set<(next: StoreState) => void>()
  return {
    getState: () => state,
    subscribe: (listener: (next: StoreState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (patch: Partial<StoreState>) => {
      state = { ...state, ...patch }
      for (const listener of listeners) {
        listener(state)
      }
    },
    reset: () => {
      state = { terminalPaneResumeOutcomesByPaneKey: {}, terminalLayoutsByTabId: {} }
      listeners.clear()
    }
  }
})

vi.mock('@/store/index', () => ({ useAppStore: store }))
vi.mock('../spawn/main-starts-pane', () => ({ mainStartsPane: () => true }))

const PANE_KEY = 'tab-1:leaf-1'

function attachedView() {
  const view = {
    cacheKey: PANE_KEY,
    disposed: false,
    deps: { tabId: 'tab-1' },
    pane: { leafId: 'leaf-1' },
    waitTeardowns: new Array<() => void>(),
    showSessionRestoredBanner: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the banner reads only these session fields; mainStartsPane is mocked.
  return { view, session: view as unknown as ConnectPanePtySession }
}

/** A fresh module, as a renderer reload loads it; session storage survives the reload. */
async function loadBannerModule(): Promise<typeof ShowOutcome> {
  vi.resetModules()
  const { showMainPaneResumeOutcome, acceptMainPaneResumeStart } =
    await import('../spawn/main-pane-resume-banner')
  const { admitTerminalNoticeLifetime } =
    await import('../../provider-notices/terminal-notice-lifetime')
  return (session, ptyId) => {
    admitTerminalNoticeLifetime(ptyId)
    acceptMainPaneResumeStart(session, ptyId)
    showMainPaneResumeOutcome(session, ptyId)
  }
}

describe("the window's banner for main's start of a pane", () => {
  let storage: Map<string, string>

  beforeEach(() => {
    store.reset()
    storage = new Map()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows once per start: a later start under the same terminal id shows again', async () => {
    const showMainPaneResumeOutcome = await loadBannerModule()
    const publish = (ptyGeneration: number, outcome: TerminalPaneResumeOutcome['outcome']) =>
      store.publish({
        terminalPaneResumeOutcomesByPaneKey: {
          [PANE_KEY]: { ptyId: 'pty-1', ptyGeneration, outcome }
        }
      })
    publish(1, 'restored')
    const first = attachedView()
    showMainPaneResumeOutcome(first.session, 'pty-1')
    // A respawn kept the daemon id; its bind raised the generation, so this is a new start.
    publish(2, 'resume-unavailable')
    const respawned = attachedView()
    showMainPaneResumeOutcome(respawned.session, 'pty-1')
    expect(respawned.view.showSessionRestoredBanner).toHaveBeenCalledExactlyOnceWith(
      'resume-unavailable'
    )
    const again = attachedView()
    showMainPaneResumeOutcome(again.session, 'pty-1')
    expect(again.view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('shows nothing again after a renderer reload reattaches the same start', async () => {
    store.publish({
      terminalPaneResumeOutcomesByPaneKey: {
        [PANE_KEY]: { ptyId: 'pty-1', ptyGeneration: 1, outcome: 'resume-unavailable' }
      }
    })
    const before = attachedView()
    ;(await loadBannerModule())(before.session, 'pty-1')
    expect(before.view.showSessionRestoredBanner).toHaveBeenCalledOnce()

    const reloaded = attachedView()
    ;(await loadBannerModule())(reloaded.session, 'pty-1')
    expect(reloaded.view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('retains a shown start across a publication gap', async () => {
    const attach = await loadBannerModule()
    const publish = (ptyId: string, ptyGeneration: number) =>
      store.publish({
        terminalPaneResumeOutcomesByPaneKey: {
          [PANE_KEY]: { ptyId, ptyGeneration, outcome: 'restored' }
        }
      })
    publish('pty-a', 3)
    const first = attachedView()
    attach(first.session, 'pty-a')
    expect(first.view.showSessionRestoredBanner).toHaveBeenCalledExactlyOnceWith('restored')
    store.publish({ terminalPaneResumeOutcomesByPaneKey: {} })
    publish('pty-b', 4)
    attach(attachedView().session, 'pty-b')
    publish('pty-a', 3)
    const remounted = attachedView()
    attach(remounted.session, 'pty-a')
    expect(remounted.view.showSessionRestoredBanner).not.toHaveBeenCalled()
    // A late older fact cannot replace the accepted start or reset suppression.
    publish('pty-a', 2)
    attach(remounted.session, 'pty-a')
    publish('pty-a', 3)
    attach(remounted.session, 'pty-a')
    expect(remounted.view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('retains a shown start across a publication gap without session storage', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: () => {
        throw new Error('storage unavailable')
      }
    })
    const attach = await loadBannerModule()
    const publish = (ptyId: string, ptyGeneration: number) =>
      store.publish({
        terminalPaneResumeOutcomesByPaneKey: {
          [PANE_KEY]: { ptyId, ptyGeneration, outcome: 'restored' }
        }
      })
    publish('pty-a', 3)
    const first = attachedView()
    attach(first.session, 'pty-a')
    expect(first.view.showSessionRestoredBanner).toHaveBeenCalledExactlyOnceWith('restored')
    store.publish({ terminalPaneResumeOutcomesByPaneKey: {} })
    publish('pty-b', 4)
    attach(attachedView().session, 'pty-b')
    publish('pty-a', 3)
    const remounted = attachedView()
    attach(remounted.session, 'pty-a')
    expect(remounted.view.showSessionRestoredBanner).not.toHaveBeenCalled()
    // A late older fact cannot replace the accepted start or reset suppression.
    publish('pty-a', 2)
    attach(remounted.session, 'pty-a')
    publish('pty-a', 3)
    attach(remounted.session, 'pty-a')
    expect(remounted.view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('shows nothing for an outcome naming another terminal', async () => {
    const showMainPaneResumeOutcome = await loadBannerModule()
    store.publish({
      terminalPaneResumeOutcomesByPaneKey: {
        [PANE_KEY]: { ptyId: 'pty-old', ptyGeneration: 1, outcome: 'restored' }
      }
    })
    const { view, session } = attachedView()
    showMainPaneResumeOutcome(session, 'pty-1')
    store.publish({
      terminalPaneResumeOutcomesByPaneKey: {
        [PANE_KEY]: { ptyId: 'pty-old', ptyGeneration: 2, outcome: 'resume-unavailable' }
      }
    })
    expect(view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })
})
