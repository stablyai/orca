import type * as SessionTabsStateModule from '../../src/renderer/src/runtime/web-session-tabs-sync/state'
import '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation'
import '../../src/renderer/src/lib/agent-session/launch/new-tab/launch-agent-web-host-tab'
import './prepared-action-launch.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-decisions'
import '../../src/renderer/src/runtime/hosted-terminals/creation/web-runtime-created-agent-prompt-delivery'
import { createWebRuntimeSessionTerminal } from '../../src/renderer/src/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { peekWebSessionFocusIntent } from '../../src/renderer/src/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync/closing/web-session-close-intent'
import {
  ENVIRONMENT_ID,
  FOCUS_LEAF_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from '../../src/renderer/src/runtime/hosted-terminals/creation/testing/web-runtime-terminal-create.test-fixture'
import { stubRuntimeEnvironmentBridge } from '../../src/renderer/src/runtime/rpc/testing/runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  changedAgentPaneKeys: new Set<string>(),
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/state', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTabsStateModule>()),
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot
}))

vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle', () => ({
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration
}))
vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock(
  '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-decisions',
  async (importOriginal) => ({
    ...(await importOriginal<typeof TrackingDecisions>()),
    decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
  })
)
vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (
    buildPatch: (state: unknown, changedAgentPaneKeys: Set<string>) => unknown
  ) => {
    mocks.setState((state: unknown) => buildPatch(state, mocks.changedAgentPaneKeys))
    return () => {}
  }
}))
vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock(
  '../../src/renderer/src/runtime/browser/creation/web-runtime-browser-materialization',
  () => ({
    hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
  })
)

afterEach(() => resetWebSessionCloseIntentForTests())

describe('createWebRuntimeSessionTerminal', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
    mocks.getState().runtimeStatusByEnvironmentId = new Map()
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it.each(
    [
      { sessionKind: 'fresh' as const, activate: true },
      { sessionKind: 'fresh' as const, activate: false },
      { sessionKind: 'resume' as const, activate: true },
      { sessionKind: 'resume' as const, activate: false }
    ].flatMap((entry) =>
      [true, false].map((keyboardSupported) => ({ ...entry, keyboardSupported }))
    )
  )(
    'keeps $sessionKind host creation background with activate=$activate and keyboard=$keyboardSupported',
    async ({ sessionKind, activate, keyboardSupported }) => {
      const hostTabId = `host-${sessionKind}-${activate ? 'active' : 'background'}`
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: [
                'agent-session.host-authority.v1',
                ...(keyboardSupported ? ['agent-session.keyboard.v1'] : [])
              ]
            }
          }
        }
        if (
          request.method === 'terminal.createAgentSession' ||
          request.method === 'terminal.ensureAgentSession'
        ) {
          return {
            id: 'agent-session',
            ok: true,
            result: {
              terminal: {
                handle: `term-${sessionKind}`,
                worktreeId: WORKTREE_ID,
                tabId: hostTabId,
                paneKey: `${hostTabId}:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          environmentId: ENVIRONMENT_ID,
          agentSessionKind: sessionKind,
          launchAgent: 'codex',
          ...(sessionKind === 'resume'
            ? {
                command: "codex resume 'session-1'",
                providerSession: { key: 'session_id' as const, id: 'session-1' }
              }
            : {}),
          activate
        })
      ).resolves.toEqual({ status: 'created' })

      const authorityMethod =
        sessionKind === 'resume' ? 'terminal.ensureAgentSession' : 'terminal.createAgentSession'
      const authorityRequest = runtimeCall.mock.calls.find(
        ([request]) => request.method === authorityMethod
      )?.[0]
      expect(authorityRequest).toMatchObject({
        selector: ENVIRONMENT_ID,
        method: authorityMethod,
        params: { presentation: 'background' }
      })
      if (keyboardSupported) {
        expect(authorityRequest).toHaveProperty('params.terminalKittyKeyboardProtocol', true)
      } else {
        expect(authorityRequest).not.toHaveProperty('params.terminalKittyKeyboardProtocol')
      }
      expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual(
        activate ? { hostTabId, leafId: FOCUS_LEAF_ID } : null
      )
      expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledTimes(activate ? 1 : 0)
    }
  )

  it.each([
    { gated: false, authority: false },
    { gated: true, authority: true }
  ])(
    'routes a Kimi resume by capability (advertised=$gated) instead of the generic host-authority probe',
    async ({ gated, authority }) => {
      // Old hosts reject widened ensureAgentSession enums without retry; per-agent probes preserve Kimi’s legacy fallback.
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: [
                'agent-session.host-authority.v1',
                ...(gated ? ['agent-session.kimi-resume.v1'] : [])
              ]
            }
          }
        }
        if (request.method === 'terminal.ensureAgentSession') {
          return {
            id: 'ensure',
            ok: true,
            result: {
              terminal: {
                handle: 'term-kimi',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-kimi',
                paneKey: `host-tab-kimi:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        if (request.method === 'session.tabs.createTerminal') {
          return {
            id: 'legacy-create',
            ok: true,
            result: { tab: { id: 'host-tab-kimi', leafId: FOCUS_LEAF_ID } }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          environmentId: ENVIRONMENT_ID,
          agentSessionKind: 'resume',
          launchAgent: 'kimi',
          command: "kimi '--session' 'session_431324d7'",
          providerSession: { key: 'session_id', id: 'session_431324d7' }
        })
      ).resolves.toEqual({ status: 'created' })

      const methods = runtimeCall.mock.calls.map(([request]) => request.method)
      expect(methods.includes('terminal.ensureAgentSession')).toBe(authority)
      expect(methods.includes('session.tabs.createTerminal')).toBe(!authority)
    }
  )

  it.each(['session.tabs.move', 'session.tabs.list'] as const)(
    'treats %s failure after host creation as accepted so callers do not duplicate the agent',
    async (failedMethod) => {
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (request.method === 'terminal.createAgentSession') {
          return {
            id: 'create',
            ok: true,
            result: {
              terminal: {
                id: 'pty-created',
                handle: 'term_created',
                title: 'Codex',
                cwd: '/repo',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-created',
                paneKey: `host-tab-created:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        if (request.method === failedMethod) {
          throw new Error(`${failedMethod} unavailable`)
        }
        return { id: 'ok', ok: true, result: makeSnapshot() }
      })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          environmentId: ENVIRONMENT_ID,
          targetGroupId: failedMethod === 'session.tabs.move' ? 'group-left' : undefined,
          launchAgent: 'codex',
          activate: true
        })
      ).resolves.toEqual({ status: 'created' })

      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.createAgentSession'
        )
      ).toHaveLength(1)
      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'session.tabs.createTerminal'
        )
      ).toHaveLength(0)
    }
  )

  it.each([false, true])(
    'bounds ambiguous authority replay with exhaustion=%s and the same operation ID',
    async (exhausted) => {
      const operationIds: string[] = []
      let createAttempts = 0
      const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (request.method === 'terminal.createAgentSession') {
          operationIds.push((request.params as { clientOperationId: string }).clientOperationId)
          createAttempts += 1
          if (createAttempts === 1 || exhausted) {
            throw new Error('connection closed before response')
          }
          return {
            id: 'create',
            ok: true,
            result: {
              terminal: {
                handle: 'term_replayed',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-replayed',
                paneKey: `host-tab-replayed:${FOCUS_LEAF_ID}`
              },
              disposition: 'replayed'
            }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      const result = await createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        launchAgent: 'codex',
        targetGroupId: 'group-left'
      })
      expect(result).toEqual(
        exhausted
          ? { status: 'failed', message: 'connection closed before response' }
          : { status: 'created' }
      )

      expect(operationIds).toHaveLength(2)
      expect(operationIds[0]).toBe(operationIds[1])
      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'session.tabs.createTerminal'
        )
      ).toHaveLength(0)
    }
  )
})
