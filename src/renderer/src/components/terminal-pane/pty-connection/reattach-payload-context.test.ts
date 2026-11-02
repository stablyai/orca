import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createPane } from '../pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection-test-environment'
import { createReattachPayloadHandlers } from './apply-reattach-payload'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { mainStartsPane } from './main-starts-pane'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

function createSession(overrides: Record<string, unknown> = {}): ReattachPayloadSession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test read only these session members.
  return {
    pane: createPane(1),
    deps: { worktreeId: 'wt-1', tabId: 'tab-1' },
    rememberReattachPayloadAgentSignal: vi.fn(),
    writeReplayData: vi.fn(),
    writeInputModeGround: vi.fn(),
    chooseReattachReplayReset: vi.fn(() => '<reset>'),
    writeReplayEpilogue: vi.fn(),
    sendFocusedReattachFocusInAfterReplay: vi.fn(),
    kittyKeyboardModes: {
      hasProvenBaseline: true,
      reset: vi.fn(),
      resetForSnapshot: vi.fn(),
      scanReplay: vi.fn(),
      adoptSnapshot: vi.fn()
    },
    ...overrides
  } as unknown as ReattachPayloadSession
}

function createContext(replay: string, attemptGeneration: number): ReattachPayloadContext {
  return {
    isCurrentReattachPayload: () => true,
    connectResult: { id: 'pty-1', replay },
    ptyId: 'pty-1',
    attemptGeneration,
    prefetchedParkModelSnapshot: null,
    revealFollowsTerminalPark: false,
    shouldApplyStructuralPayload: true,
    coldRestoreStartup: undefined,
    reattachPayloadApplied: false,
    skippedAltFrameCaptureCols: null
  }
}

describe('reattach payload context', () => {
  beforeEach(async () => {
    await installTerminalTestGlobals()
  })

  afterEach(async () => restoreTerminalTestGlobals())

  it('keeps overlapping payload handlers bound to their own attempt', async () => {
    const session = createSession()
    const attemptA = createReattachPayloadHandlers(session, createContext('PAYLOAD-A', 1))
    const attemptB = createReattachPayloadHandlers(session, createContext('PAYLOAD-B', 2))

    await attemptB.applyReattachPayload()
    await attemptA.applyReattachPayload()

    expect(session.rememberReattachPayloadAgentSignal.mock.calls).toEqual([
      ['PAYLOAD-B', { fullScreenReplay: true }],
      ['PAYLOAD-A', { fullScreenReplay: true }]
    ])
    expect(session.sendFocusedReattachFocusInAfterReplay.mock.calls).toEqual([
      ['pty-1', 2],
      ['pty-1', 1]
    ])
  })

  it('uses the connect startup plan without rebuilding or scheduling paste delivery', async () => {
    const startup = {
      command: 'codex resume provider-session',
      agent: 'codex',
      resumeProviderSession: { key: 'session_id', id: 'provider-session' },
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
      launchToken: 'transport-launch-token',
      useLiveEntry: false,
      hasSleepingRecord: false,
      sleepingRecordEntry: null
    } as ColdRestoreAgentResumeStartup
    const buildColdRestoreAgentResumeStartup = vi.fn()
    const applyColdRestoreAgentResumeStartup = vi.fn((value) => Boolean(value))
    const schedulePendingStartupCommandDelivery = vi.fn()
    const session = createSession({
      buildColdRestoreAgentResumeStartup,
      applyColdRestoreAgentResumeStartup,
      schedulePendingStartupCommandDelivery,
      showSessionRestoredBanner: vi.fn(),
      clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
      consumeRestoredViewportBlankingMarker: vi.fn(),
      writeFreshShellViewportBlanking: vi.fn()
    })
    const context: ReattachPayloadContext = {
      ...createContext('', 1),
      connectResult: {
        id: 'pty-1',
        coldRestore: { scrollback: 'restored scrollback', cwd: '/workspace' }
      },
      coldRestoreStartup: startup
    }

    await createReattachPayloadHandlers(session, context).applyReattachPayload()

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main started the pane and resumed its agent; the window's paint applies no resume.
      expect(applyColdRestoreAgentResumeStartup).toHaveBeenCalledExactlyOnceWith(null)
      expect(session.clearSleepingRecordAfterColdRestoreSpawn).not.toHaveBeenCalled()
      expect(session.showSessionRestoredBanner).not.toHaveBeenCalled()
    } else {
      expect(applyColdRestoreAgentResumeStartup).toHaveBeenCalledWith(startup)
    }
    expect(buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
    expect(schedulePendingStartupCommandDelivery).not.toHaveBeenCalled()
    expect(context.reattachPayloadApplied).toBe(true)
  })
})

it.each(['missing', 'different', 'admitted'] as const)(
  'authorizes only the checked late saved candidate (%s)',
  async (kind) => {
    await installTerminalTestGlobals()
    try {
      const startup: ColdRestoreAgentResumeStartup = {
        command: 'codex resume C',
        agent: 'codex',
        resumeOrigin: 'saved',
        resumeProviderSession: { key: 'session_id', id: 'C' },
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        launchToken: 'saved-C',
        resumeSource: { cancelled: false },
        useLiveEntry: false,
        hasSleepingRecord: false,
        sleepingRecordEntry: null
      }
      const apply = vi.fn((value) => Boolean(value))
      const cancel = vi.fn()
      const schedule = vi.fn()
      const session = createSession({
        // Main can hand a twin's start back to this renderer-owned launch path.
        mainPaneStartHandedBack: true,
        buildColdRestoreAgentResumeStartup: () => startup,
        applyColdRestoreAgentResumeStartup: apply,
        cancelSavedResumeStartup: cancel,
        schedulePendingStartupCommandDelivery: schedule,
        clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
        showSessionRestoredBanner: vi.fn(),
        consumeRestoredViewportBlankingMarker: vi.fn(),
        writeFreshShellViewportBlanking: vi.fn()
      })
      expect(mainStartsPane(session)).toBe(false)
      const context = createContext('', 1)
      context.connectResult = {
        id: 'pty-1',
        coldRestore: { scrollback: '', cwd: '/workspace' },
        ...(kind === 'missing'
          ? {}
          : {
              savedResumeDecision: {
                agent: 'codex',
                providerSession: { key: 'session_id', id: kind === 'different' ? 'D' : 'C' },
                verdict: 'admitted'
              }
            })
      }
      await createReattachPayloadHandlers(session, context).applyReattachPayload()
      expect(apply).toHaveBeenCalledWith(kind === 'admitted' ? startup : null)
      expect(schedule).toHaveBeenCalledTimes(kind === 'admitted' ? 1 : 0)
      expect(cancel).toHaveBeenCalledTimes(kind === 'admitted' ? 0 : 1)
    } finally {
      await restoreTerminalTestGlobals()
    }
  }
)

it.each(['missing', 'admitted', 'prepared'] as const)(
  'observes a cached cold owner without consuming an uncorrelated newer recipe (%s)',
  async (kind) => {
    await installTerminalTestGlobals()
    const record = {
      paneKey: 'tab:leaf',
      worktreeId: 'wt',
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'C' },
      state: 'done' as const,
      prompt: '',
      capturedAt: 20,
      updatedAt: 20
    }
    const previousRecords = useAppStore.getState().sleepingAgentSessionsByPaneKey
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [record.paneKey]: record } })
    try {
      const startup: ColdRestoreAgentResumeStartup = {
        command: 'codex resume C',
        agent: 'codex',
        resumeOrigin: 'saved',
        resumeProviderSession: record.providerSession,
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        launchToken: 'replacement-token',
        useLiveEntry: false,
        hasSleepingRecord: true,
        sleepingRecordEntry: { paneKey: record.paneKey, record }
      }
      const session = createSession({
        cacheKey: record.paneKey,
        buildColdRestoreAgentResumeStartup: vi.fn(() => startup),
        applyColdRestoreAgentResumeStartup: vi.fn(() => true),
        cancelSavedResumeStartup: vi.fn(),
        schedulePendingStartupCommandDelivery: vi.fn(),
        clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
        showSessionRestoredBanner: vi.fn(),
        consumeRestoredViewportBlankingMarker: vi.fn(),
        writeFreshShellViewportBlanking: vi.fn()
      })
      const context: ReattachPayloadContext = {
        ...createContext('', 1),
        connectResult: {
          id: 'pty-1',
          isReattach: true,
          coldRestore: { scrollback: 'cached history', cwd: '/workspace' },
          ...(kind === 'admitted'
            ? {
                savedResumeDecision: {
                  agent: 'codex',
                  providerSession: record.providerSession,
                  verdict: 'admitted'
                }
              }
            : {})
        },
        coldRestoreStartup: kind === 'prepared' ? startup : null
      }
      await createReattachPayloadHandlers(session, context).applyReattachPayload()
      expect(session.writeReplayData).toHaveBeenCalledWith(
        expect.stringContaining('cached history')
      )
      expect(window.api.pty.ackColdRestore).toHaveBeenCalledOnce()
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        expect(window.api.pty.ackColdRestore).toHaveBeenCalledWith('pty-1', {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: session.pane.leafId
        })
      } else {
        expect(window.api.pty.ackColdRestore).toHaveBeenCalledWith('pty-1')
      }
      expect(context.reattachPayloadApplied).toBe(true)
      expect(session.buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
      expect(session.applyColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
      expect(session.cancelSavedResumeStartup).not.toHaveBeenCalled()
      expect(session.schedulePendingStartupCommandDelivery).not.toHaveBeenCalled()
      expect(session.clearSleepingRecordAfterColdRestoreSpawn).not.toHaveBeenCalled()
      expect(session.showSessionRestoredBanner).not.toHaveBeenCalled()
      expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
      expect(window.api.pty.write).not.toHaveBeenCalled()
    } finally {
      useAppStore.setState({ sleepingAgentSessionsByPaneKey: previousRecords })
      await restoreTerminalTestGlobals()
    }
  }
)
