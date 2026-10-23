import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import type { TerminalLayoutSnapshot } from '../../../../../shared/terminal-tab-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { showMainPaneResumeOutcome as ShowOutcome } from './main-pane-resume-banner'

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
    },
    listenerCount: () => listeners.size
  }
})

vi.mock('@/store', () => ({ useAppStore: store }))
vi.mock('./main-starts-pane', () => ({ mainStartsPane: () => true }))

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
  return (await import('./main-pane-resume-banner')).showMainPaneResumeOutcome
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

  it('shows the outcome of the terminal the view attached, once per start', async () => {
    const showMainPaneResumeOutcome = await loadBannerModule()
    store.publish({
      terminalPaneResumeOutcomesByPaneKey: {
        [PANE_KEY]: { ptyId: 'pty-1', ptyGeneration: 1, outcome: 'restored' }
      }
    })
    const first = attachedView()
    showMainPaneResumeOutcome(first.session, 'pty-1')
    expect(first.view.showSessionRestoredBanner).toHaveBeenCalledExactlyOnceWith('restored')

    // A remounted view attaching the same start says nothing again.
    const remounted = attachedView()
    showMainPaneResumeOutcome(remounted.session, 'pty-1')
    expect(remounted.view.showSessionRestoredBanner).not.toHaveBeenCalled()
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

  it('subscribes to nothing: the outcome rides the frame the attach follows', async () => {
    const showMainPaneResumeOutcome = await loadBannerModule()
    const { view, session } = attachedView()
    showMainPaneResumeOutcome(session, 'pty-1')
    expect(store.listenerCount()).toBe(0)
    expect(view.waitTeardowns).toEqual([])
    expect(view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })
})

describe("a held pane's reopen count from main's outcome", () => {
  beforeEach(() => store.reset())

  const publish = (ptyId: string, ptyGeneration: number) =>
    store.publish({
      terminalPaneResumeOutcomesByPaneKey: {
        [PANE_KEY]: { ptyId, ptyGeneration, outcome: 'restored' }
      }
    })

  it("counts main's start since the attach began, for the terminal the attach got", async () => {
    vi.resetModules()
    const { attachResumeCheck } = await import('./main-pane-resume-banner')
    const resumed = attachResumeCheck(attachedView().session, null)
    publish('pty-1', 2)
    expect(resumed('pty-1')).toBe(true)
    // The attach's own result names the terminal it got, over the id it asked for.
    expect(resumed('pty-asked', { id: 'pty-1' })).toBe(true)
    expect(resumed('pty-1', { id: 'pty-other' })).toBe(false)
  })

  it('does not count a start main resumed before the attach began', async () => {
    vi.resetModules()
    const { attachResumeCheck } = await import('./main-pane-resume-banner')
    publish('pty-1', 1)
    const resumed = attachResumeCheck(attachedView().session, null)
    expect(resumed('pty-1')).toBe(false)
    // A later start under the same id (a new bind generation) counts.
    publish('pty-1', 2)
    expect(resumed('pty-1')).toBe(true)
  })
})
