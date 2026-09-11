import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPane } from '../pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection-test-environment'
import { createReattachPayloadHandlers } from './apply-reattach-payload'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

function createSession(overrides: Record<string, unknown> = {}): ReattachPayloadSession {
  return {
    pane: createPane(1),
    rememberReattachPayloadAgentSignal: vi.fn(),
    writeReplayData: vi.fn(),
    reattachReplayResetSequence: vi.fn(() => '<reset>'),
    sendFocusedReattachFocusInAfterReplay: vi.fn(),
    kittyKeyboardModes: {
      hasProvenBaseline: true,
      reset: vi.fn(),
      resetForSnapshot: vi.fn(),
      scanReplay: vi.fn()
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
    reconnectMayUseModel: false,
    fetchSshMainModelReattachSnapshot: async () => null,
    shouldApplyStructuralPayload: true,
    coldRestoreStartup: undefined,
    reattachPayloadApplied: false
  }
}

describe('reattach payload context', () => {
  beforeEach(() => installTerminalTestGlobals())

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
    const applyColdRestoreAgentResumeStartup = vi.fn(() => true)
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

    expect(applyColdRestoreAgentResumeStartup).toHaveBeenCalledWith(startup)
    expect(buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
    expect(schedulePendingStartupCommandDelivery).not.toHaveBeenCalled()
    expect(context.reattachPayloadApplied).toBe(true)
  })
})
