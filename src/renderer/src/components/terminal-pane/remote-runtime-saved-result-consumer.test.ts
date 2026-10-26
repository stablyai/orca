import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TerminalAttachmentLaunchResult } from '../../../../shared/terminal-attachment-launch-result'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import type { AgentLaunchConfigRegistryEntry } from '@/store/slices/agent-status/agent-status-contract'
import { bindCaptureTransportOutputCallbacks } from './pty-connection/transport-output-callbacks'
import { bindSettlePaneSerializer } from './pty-connection/pane-serializer-settle'
import { applyTerminalLaunchResult } from './pty-connection/terminal-launch-result-policy'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import { installSavedResumeStartupCancellation } from './pty-connection/saved-resume-startup-cancellation'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

const fixture = vi.hoisted(() => ({ state: {} }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => fixture.state } }))
let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'
const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitSnapshot,
  inputFrameTexts,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})
beforeEach(resetRemoteRuntimeTransport)
afterEach(() => vi.clearAllMocks())

it.each([
  'refused',
  'adopted',
  'adopted-D',
  'observer-only',
  'unavailable',
  'legacy',
  'ackless',
  'malformed',
  'bookkeeping-error',
  'new-C',
  'new-D',
  'stale-generation'
] as const)(
  'delivers the actual mirror %s result to the pane without replaying or clearing newer work',
  async (kind) => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    const record = {
      paneKey: 'web-terminal-host-tab-1:pane:1',
      tabId: 'web-terminal-host-tab-1',
      worktreeId: 'wt-1',
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'C' },
      connectionId: null,
      state: 'done' as const,
      prompt: '',
      capturedAt: 10,
      updatedAt: 10,
      origin: 'worktree-sleep' as const
    }
    const source = { cancelled: false, record }
    const startup = {
      command: 'codex resume C',
      launchAgent: 'codex' as const,
      resumeProviderSession: record.providerSession,
      resumeOrigin: 'saved' as const,
      resumeSource: source
    }
    const registry: Record<string, AgentLaunchConfigRegistryEntry> = {}
    const records = { [record.paneKey]: record }
    const clearRecord = vi.fn((key: string) => {
      delete records[key]
    })
    fixture.state = {
      agentLaunchConfigByPaneKey: registry,
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: records,
      automaticAgentResumeClaimsByTabId: {},
      pendingStartupByTabId: {},
      tabsByWorktree: {},
      consumeTabStartupCommand: vi.fn(() => {
        if (kind === 'bookkeeping-error') {
          throw new Error('bookkeeping failed')
        }
      }),
      clearSleepingAgentSession: clearRecord
    }
    const note = vi.fn()
    const register = vi.fn()
    const callbacksReady = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real callback and cancellation installers use the supplied session members.
    const session = {
      transport,
      pane: { id: 1, leafId: 'pane:1', container: { dataset: {} }, terminal: {} },
      deps: {
        worktreeId: 'wt-1',
        tabId: record.tabId,
        isVisibleRef: { current: true },
        onShowSessionRestoredBanner: note,
        paneTransportsRef: { current: new Map([[1, transport]]) }
      },
      cacheKey: record.paneKey,
      paneStartup: kind === 'observer-only' ? null : startup,
      pendingStartupCommand: kind === 'observer-only' ? null : startup,
      shouldDeliverStartupViaTerminalPaste: true,
      startupInjectTimer: null,
      transportStreamGeneration: 0,
      disposed: false,
      createProcessExitState: () => ({ detector: { observe: vi.fn() } }),
      clearRegisteredStartupLaunchConfig: vi.fn(),
      registerEffectiveLaunchConfig: register,
      showSessionRestoredBanner: note,
      reportRemoteRendererSerializerReady: callbacksReady,
      syncHiddenRendererPtyDelivery: vi.fn(),
      handleRemoteOutputPauseChanged: vi.fn(),
      markHiddenOutputRestoreNeeded: vi.fn(),
      beginReattachLiveDataDeferralIfUnowned: vi.fn(),
      replayDataCallback: vi.fn(),
      dataCallback: vi.fn()
    } as unknown as ConnectPanePtySession
    installSavedResumeStartupCancellation(session)
    bindSettlePaneSerializer(session)
    session.reportRemoteRendererSerializerReady = callbacksReady
    bindCaptureTransportOutputCallbacks(session)
    const output = session.captureTransportOutputCallbacks(vi.fn(), null)
    const actualConfig = { agentCommand: 'codex', agentArgs: '--model actual', agentEnv: {} }
    const launchResult: TerminalAttachmentLaunchResult = {
      ptyId: 'physical-1',
      incarnationId: 'incarnation-1',
      ...(kind === 'adopted'
        ? {}
        : {
            savedResumeDecision: {
              agent: 'codex',
              providerSession:
                kind === 'adopted-D' ? { key: 'session_id', id: 'D' } : record.providerSession,
              verdict: kind === 'unavailable' ? 'admitted' : 'chat-home'
            },
            agentResumeUnavailable: true,
            ...(kind === 'unavailable' ? {} : { agentResumeRefused: 'chat-home' })
          }),
      ...(kind === 'adopted' || kind === 'adopted-D' || kind === 'unavailable'
        ? {
            launchAgent: 'codex',
            launchToken: 'actual-token',
            launchConfig: actualConfig
          }
        : {})
    }
    subscriptionSendBinary.mockImplementation((bytes) => {
      if (decodeTerminalStreamFrame(bytes)?.opcode !== TerminalStreamOpcode.Subscribe) {
        return
      }
      if (kind === 'new-C' || kind === 'new-D') {
        const providerSession = {
          key: 'session_id' as const,
          id: kind === 'new-D' ? 'D' : 'C'
        }
        const newer = {
          ...startup,
          resumeProviderSession: providerSession,
          resumeSource: { cancelled: false }
        }
        session.paneStartup = newer
        session.pendingStartupCommand = newer
        registry[record.paneKey] = { launchConfig: actualConfig, identity: {}, registeredAt: 20 }
        records[record.paneKey] = { ...record, providerSession, updatedAt: 20 }
      }
      if (kind === 'stale-generation') {
        session.transportStreamGeneration += 1
      }
      const { streamId, terminal } = latestSubscribePayload()
      // Arrive synchronously while subscribeTerminal is still installing the stream.
      if (kind === 'ackless') {
        return
      }
      subscriptionCallbacks?.onResponse({
        ok: true,
        result: {
          type: 'subscribed',
          streamId,
          terminal,
          ...(kind === 'legacy'
            ? {}
            : {
                launchResult:
                  kind === 'malformed'
                    ? { ...launchResult, savedResumeDecision: { agent: 'codex' } }
                    : launchResult
              })
        }
      })
    })
    try {
      transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: output.callbacks })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(callbacksReady).not.toHaveBeenCalled()
      const { streamId } = latestSubscribePayload()
      const resolvesBeforeSnapshot = runtimeCall.mock.calls.filter(
        ([request]) => request.method === 'terminal.resolvePane'
      ).length
      transport.sendInput('ordinary-input', 'driving')
      if (kind === 'ackless') {
        expect(inputFrameTexts().join('')).not.toContain('ordinary-input')
      } else {
        await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('ordinary-input'))
      }
      if (kind === 'refused' || kind === 'bookkeeping-error' || kind === 'unavailable') {
        expect(session.pendingStartupCommand).toBeNull()
      }
      emitSnapshot(streamId, 'shell$ ')
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toContain('ordinary-input'))
      if (kind !== 'stale-generation') {
        expect(callbacksReady).toHaveBeenCalledTimes(1)
      }
      const refused =
        kind === 'refused' || kind === 'bookkeeping-error' || kind === 'new-C' || kind === 'new-D'
      expect(source.cancelled).toBe(refused || kind === 'unavailable')
      expect(note).toHaveBeenCalledTimes(
        kind === 'refused' ||
          kind === 'bookkeeping-error' ||
          kind === 'observer-only' ||
          kind === 'unavailable'
          ? 1
          : 0
      )
      expect(clearRecord).toHaveBeenCalledTimes(
        kind === 'refused' || kind === 'unavailable' ? 1 : 0
      )
      if (kind === 'new-C' || kind === 'new-D') {
        expect(session.paneStartup?.resumeSource?.cancelled).toBe(false)
        expect(session.pendingStartupCommand).toBe(session.paneStartup)
        expect(records[record.paneKey].updatedAt).toBe(20)
        expect(register).not.toHaveBeenCalled()
      } else if (kind === 'adopted' || kind === 'unavailable') {
        expect(register).toHaveBeenCalledWith(actualConfig, {
          launchAgent: 'codex',
          launchToken: 'actual-token'
        })
      } else if (kind === 'refused' || kind === 'observer-only') {
        expect(session.pendingStartupCommand).toBeNull()
        expect(session.paneStartup).toBeNull()
        expect(register).toHaveBeenCalledWith(undefined, {
          launchAgent: undefined,
          launchToken: undefined
        })
      } else if (kind !== 'bookkeeping-error') {
        expect(register).not.toHaveBeenCalled()
      }
      if (kind === 'adopted-D') {
        applyTerminalLaunchResult(
          session,
          { ...launchResult, isReattach: true },
          output.launchContext,
          'creator'
        )
        expect(source.cancelled).toBe(false)
        expect(session.pendingStartupCommand?.resumeSource).toBe(source)
        expect(records[record.paneKey]).toBe(record)
        expect(clearRecord).not.toHaveBeenCalled()
        expect(register).toHaveBeenCalledWith(actualConfig, {
          launchAgent: 'codex',
          launchToken: 'actual-token'
        })
      }
      if (kind === 'refused' || kind === 'unavailable') {
        // The returning creator repeats the acknowledgment; existing note idempotence survives.
        applyTerminalLaunchResult(session, launchResult, output.launchContext, 'creator')
        expect(note).toHaveBeenCalledTimes(1)
      }
      expect(inputFrameTexts().join('')).not.toContain('codex resume C')
      expect(
        runtimeCall.mock.calls.filter(([request]) => request.method === 'terminal.resolvePane')
      ).toHaveLength(resolvesBeforeSnapshot)
      expect(runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.create')).toBe(
        false
      )
      expect(runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.send')).toBe(
        false
      )
    } finally {
      transport.disconnect()
    }
  }
)

it.each(['subscription', 'recovery'] as const)(
  'rejects predecessor %s facts while a successor connect owns the callback bundle',
  async (operation) => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'pane:1'
    })
    const predecessorResult = vi.fn()
    const successorResult = vi.fn()
    const launchResult: TerminalAttachmentLaunchResult = {
      ptyId: 'physical-1',
      incarnationId: 'incarnation-1',
      agentResumeRefused: 'chat-home',
      savedResumeDecision: {
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'C' },
        verdict: 'chat-home'
      }
    }
    let finishRecovery: (value: unknown) => void = () => {}
    const recoveryResult = new Promise((resolve) => {
      finishRecovery = resolve
    })
    let finishActivation: (value: unknown) => void = () => {}
    const activationResult = new Promise((resolve) => {
      finishActivation = resolve
    })
    try {
      transport.attach({
        existingPtyId: 'remote:env-1@@terminal-1',
        callbacks: { onLaunchResult: predecessorResult }
      })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      const { streamId, terminal } = latestSubscribePayload()
      const defaultCall = runtimeCall.getMockImplementation()
      runtimeCall.mockImplementation((request: { method: string }) => {
        if (request.method === 'terminal.recoverPane') {
          return recoveryResult
        }
        if (request.method === 'session.tabs.activate') {
          return activationResult
        }
        return defaultCall?.(request)
      })
      if (operation === 'recovery') {
        subscriptionCallbacks?.onResponse({
          ok: true,
          result: { type: 'error', streamId, message: 'SSH_SESSION_EXPIRED: relay changed' }
        })
        await vi.waitFor(() =>
          expect(runtimeCall).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'terminal.recoverPane' })
          )
        )
      }
      const successor = transport.connect({
        url: '',
        callbacks: { onLaunchResult: successorResult }
      })
      await vi.waitFor(() =>
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'session.tabs.activate' })
        )
      )
      subscriptionCallbacks?.onResponse({
        ok: true,
        result: { type: 'subscribed', streamId, terminal, launchResult }
      })
      finishRecovery({
        ok: true,
        result: { terminal: { handle: terminal, ...launchResult } }
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(predecessorResult).not.toHaveBeenCalled()
      expect(successorResult).not.toHaveBeenCalled()
      transport.disconnect()
      finishActivation({ ok: true, result: {} })
      await successor
    } finally {
      transport.disconnect()
      finishRecovery({ ok: true, result: {} })
      finishActivation({ ok: true, result: {} })
    }
  }
)
