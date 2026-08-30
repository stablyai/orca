/**
 * Regression for #8457 / STA-1716 acceptance criterion 6: desktop exit +
 * surviving daemon sessions + headless `serve` holding the single-instance lock
 * + a GUI activation attempt.
 *
 * The incident chain was: Cmd+Q leaves a packaged `orca serve` owning the
 * profile lock, a forced relaunch reaches that headless process, it mounts a
 * desktop renderer, and hydration cold-restores panes whose daemon PTYs are
 * still alive — launching duplicate `codex resume <session>` agents and
 * interrupting the live ones.
 *
 * Both halves are joined here because either alone passes vacuously: promotion
 * is only safe if hydration resumes nothing, and resuming nothing only matters
 * if promotion actually happens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App, BrowserWindow } from 'electron'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { focusExistingMainWindow } from '../../../main/window/focus-existing-window'
import { createMacAppActivationHandler } from '../../../main/window/macos-app-activation'
import {
  createServeDesktopActivationGate,
  settleServeDesktopActivation
} from '../../../main/startup/serve-desktop-activation'
import {
  acquireSingleInstanceLock,
  shouldActivateDesktopForSecondInstance,
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock
} from '../../../main/startup/single-instance-lock'

const WORKTREE_ID = 'wt-serve-promotion'
const AGENT_PANES = [
  { tabId: 'tab-codex-1', leafId: '11111111-1111-4111-8111-111111111111', ptyId: 'daemon-pty-1' },
  { tabId: 'tab-codex-2', leafId: '22222222-2222-4222-8222-222222222222', ptyId: 'daemon-pty-2' },
  { tabId: 'tab-codex-3', leafId: '33333333-3333-4333-8333-333333333333', ptyId: 'daemon-pty-3' }
] as const
/** Argv macOS delivers for `open -n -a Orca` / Finder / Dock relaunch. */
const DESKTOP_RELAUNCH_ARGV = ['/Applications/Orca.app/Contents/MacOS/Orca'] as const
const DUPLICATE_SERVE_ARGV = [
  '/Applications/Orca.app/Contents/MacOS/Orca',
  '--serve',
  '--serve-json',
  '--serve-port',
  '6769'
] as const

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function createFakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isAlwaysOnTop: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    moveTop: vi.fn()
  } as unknown as BrowserWindow
}

/**
 * Mirrors only the injection index.ts performs (gate -> focusExistingWindow ->
 * openMainWindow, second-instance -> requestDesktopActivation); every decision
 * under test comes from the production modules.
 */
function bootHeadlessServeOwner(): {
  openMainWindowCalls: () => number
  desktopWindowStatus: () => string
  blockedReasons: readonly string[]
  secondInstance: (argv: readonly string[]) => void
  dockActivate: () => void
  settle: (options: { hasPersistentPtyProvider: boolean }) => void
} {
  let mainWindow: BrowserWindow | null = null
  const openMainWindow = vi.fn(() => {
    mainWindow = createFakeWindow()
    return mainWindow
  })
  const blockedReasons: string[] = []
  const gate = createServeDesktopActivationGate({
    initialState: 'initializing',
    activateWindow: () => {
      focusExistingMainWindow({
        app: { focus: vi.fn(), isReady: () => true } as unknown as App,
        getWindow: () => mainWindow,
        openWindow: openMainWindow,
        platform: 'darwin'
      })
    },
    onBlocked: (reason) => blockedReasons.push(reason)
  })
  const requestDesktopActivation = (argv: readonly string[] = []): void => {
    if (!shouldActivateDesktopForSecondInstance(argv)) {
      return
    }
    gate.requestActivation()
  }
  const secondInstanceHandlers: ((argv: readonly string[]) => void)[] = []
  const lockApp = {
    requestSingleInstanceLock: () => true,
    on: (event: string, listener: (event: unknown, argv: readonly string[]) => void) => {
      if (event === 'second-instance') {
        secondInstanceHandlers.push((argv) => listener({}, argv))
      }
    }
  } as unknown as App
  expect(acquireSingleInstanceLock(lockApp, requestDesktopActivation)).toBe(true)
  expect(secondInstanceHandlers).toHaveLength(1)

  return {
    openMainWindowCalls: () => openMainWindow.mock.calls.length,
    desktopWindowStatus: () => {
      const state = gate.getState()
      return state === 'ready' ? 'openable' : state
    },
    blockedReasons,
    secondInstance: (argv) => {
      for (const handler of secondInstanceHandlers) {
        handler(argv)
      }
    },
    dockActivate: createMacAppActivationHandler({
      getWindow: () => mainWindow,
      isWindowReachable: () => true,
      requestActivation: () => requestDesktopActivation(DESKTOP_RELAUNCH_ARGV)
    }),
    settle: (options) => settleServeDesktopActivation(gate, options)
  }
}

function makeTerminalTab(id: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeSurvivingAgentRecord(index: number): SleepingAgentSessionRecord {
  const pane = AGENT_PANES[index]
  return {
    paneKey: makePaneKey(pane.tabId, pane.leafId),
    tabId: pane.tabId,
    worktreeId: WORKTREE_ID,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `provider-session-${index + 1}` },
    prompt: 'keep working',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    // Why: Cmd+Q captures live agents as quit-origin records — the exact input
    // the promoted renderer replays.
    origin: 'quit'
  }
}

/**
 * Seeds the store the way a renderer freshly mounted inside the serve process
 * sees it: persisted tabs/layouts with their daemon PTY bindings, and no live
 * PTY map yet unless reattach has already run.
 */
function hydratePromotedRenderer(options: { reattached: boolean }): SleepingAgentSessionRecord[] {
  const records = AGENT_PANES.map((_, index) => makeSurvivingAgentRecord(index))
  useAppStore.setState(
    {
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'terminal',
      // Only the first tab is the visible one; the other two mount hidden.
      activeTabId: AGENT_PANES[0].tabId,
      activeTabIdByWorktree: { [WORKTREE_ID]: AGENT_PANES[0].tabId },
      tabsByWorktree: { [WORKTREE_ID]: AGENT_PANES.map((pane) => makeTerminalTab(pane.tabId)) },
      terminalLayoutsByTabId: Object.fromEntries(
        AGENT_PANES.map((pane) => [
          pane.tabId,
          {
            root: { type: 'leaf', leafId: pane.leafId },
            activeLeafId: pane.leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [pane.leafId]: pane.ptyId }
          }
        ])
      ),
      ptyIdsByTabId: options.reattached
        ? Object.fromEntries(AGENT_PANES.map((pane) => [pane.tabId, [pane.ptyId]]))
        : {},
      sleepingAgentSessionsByPaneKey: Object.fromEntries(
        records.map((record) => [record.paneKey, record])
      )
    } as never,
    false
  )
  return records
}

function expectNoAgentWasResumed(records: readonly SleepingAgentSessionRecord[]): void {
  const state = useAppStore.getState()
  expect(state.tabsByWorktree[WORKTREE_ID]).toHaveLength(AGENT_PANES.length)
  expect(Object.keys(state.pendingStartupByTabId)).toEqual([])
  expect(Object.keys(state.automaticAgentResumeClaimsByTabId)).toEqual([])
  for (const record of records) {
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  }
}

describe('#8457 headless serve promotion preserves surviving agent sessions', () => {
  it('leaves a packaged serve process owning the single-instance lock', () => {
    expect(shouldSkipSingleInstanceLock({ isDev: false, isServeMode: true, env: {} })).toBe(false)
    expect(
      shouldBypassSingleInstanceLock({
        platform: 'darwin',
        isDev: false,
        isServeMode: true,
        env: { ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1' }
      })
    ).toBe(false)
  })

  it('opens exactly one desktop window for a forced relaunch, and only after settle', () => {
    const serve = bootHeadlessServeOwner()

    serve.secondInstance(DESKTOP_RELAUNCH_ARGV)
    expect(serve.desktopWindowStatus()).toBe('initializing')
    expect(serve.openMainWindowCalls()).toBe(0)

    serve.settle({ hasPersistentPtyProvider: true })
    expect(serve.desktopWindowStatus()).toBe('openable')
    expect(serve.openMainWindowCalls()).toBe(1)

    // Dock/Finder activation now finds the window and must not build another.
    serve.dockActivate()
    serve.secondInstance(DESKTOP_RELAUNCH_ARGV)
    expect(serve.openMainWindowCalls()).toBe(1)
    expect(serve.blockedReasons).toEqual([])
  })

  it('ignores a duplicate `orca serve` launch instead of promoting the headless owner', () => {
    const serve = bootHeadlessServeOwner()

    serve.secondInstance(DUPLICATE_SERVE_ARGV)
    serve.settle({ hasPersistentPtyProvider: true })

    expect(serve.openMainWindowCalls()).toBe(0)
  })

  it('fails closed with a diagnostic when the persistent PTY provider is unavailable', () => {
    const serve = bootHeadlessServeOwner()

    serve.secondInstance(DESKTOP_RELAUNCH_ARGV)
    serve.settle({ hasPersistentPtyProvider: false })

    expect(serve.openMainWindowCalls()).toBe(0)
    expect(serve.desktopWindowStatus()).toBe('blocked')
    expect(serve.blockedReasons).toEqual(['persistent PTY provider unavailable'])
  })

  it('resumes zero agents when the promoted renderer hydrates surviving daemon panes', () => {
    const serve = bootHeadlessServeOwner()
    serve.secondInstance(DESKTOP_RELAUNCH_ARGV)
    serve.settle({ hasPersistentPtyProvider: true })
    expect(serve.openMainWindowCalls()).toBe(1)

    const records = hydratePromotedRenderer({ reattached: false })

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expectNoAgentWasResumed(records)
  })

  it('resumes zero agents on the hydration pass after the panes rebind their PTYs', () => {
    const serve = bootHeadlessServeOwner()
    serve.secondInstance(DESKTOP_RELAUNCH_ARGV)
    serve.settle({ hasPersistentPtyProvider: true })

    const records = hydratePromotedRenderer({ reattached: true })

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expectNoAgentWasResumed(records)
  })
})
