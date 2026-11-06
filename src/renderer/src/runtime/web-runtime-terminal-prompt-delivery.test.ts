import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverCreatedWebRuntimeAgentSessionPrompt } from './web-runtime-terminal-creation'
import {
  rebindPendingAgentStartupPrompt,
  resetAgentStartupDelayedDeliveryForTests
} from '../lib/agent-startup-delayed-delivery'
import {
  agentStartupDeliveryKey,
  isAgentStartupDeliveryConsumed,
  forgetAgentStartupDeliveriesForTabs
} from '../lib/agent-startup-delivery-guards'

const mocks = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<boolean>>(),
  write: vi.fn<(_pty: string, _data: string) => Promise<boolean>>(),
  error: vi.fn(),
  draft: vi.fn(),
  prompt: vi.fn(),
  failed: vi.fn()
}))
import { useAppStore } from '@/store'
import { registerAgentStartupTerminalBinding } from '@/lib/agent-startup-tab-binding'
import { installSleepingRecordAccess } from '@/components/terminal-pane/pty-connection/sleeping-record-access'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { installPtyExitHibernate } from '@/components/terminal-pane/pty-connection/pty-exit-hibernate'
import { installPanePtyVisibilityBind } from '@/components/terminal-pane/pty-connection/pane-pty-visibility-bind'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from '@/components/terminal-pane/remote-runtime-pty-recovery-limits'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
const originalState = useAppStore.getState()
const ptyId = 'remote:env@@pty-1'
const leafId = '11111111-1111-4111-8111-111111111111'
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('../lib/agent-draft-readiness', () => ({ waitForAgentDraftInputReady: mocks.ready }))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: mocks.write
}))

const identity = { worktreeId: 'wt', tabId: 'tab-1', launchToken: 'launch-1', environmentId: 'env' }
const created = { outcome: { status: 'created' as const } }
function deliver(content = 'ship it\nwith tests', submit = false, beforePaste = () => true) {
  return deliverCreatedWebRuntimeAgentSessionPrompt(created, {
    agent: 'codex',
    rendererTabId: 'tab-1',
    startupDelivery: identity,
    promptAfterReady: content,
    submitPrompt: submit,
    forcePromptPaste: true,
    launchPty: Promise.resolve(ptyId),
    beforePaste
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.ready.mockReset()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  })
  useAppStore.setState({
    tabsByWorktree: { wt: [{ id: 'tab-1', ptyId: ptyId }] },
    pendingStartupByTabId: {},
    agentLaunchConfigByPaneKey: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: { 'tab-1': [ptyId] },
    seedNativeChatLaunchDraft: mocks.draft,
    seedNativeChatLaunchPrompt: mocks.prompt,
    markNativeChatLaunchPromptFailed: mocks.failed
  } as never)
  mocks.write.mockResolvedValue(true)
})
afterEach(() => {
  resetAgentStartupDelayedDeliveryForTests()
  useAppStore.setState(originalState, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('recovers consumed startup after an unknown-liveness retirement and remount', async () => {
  const firstReady = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValueOnce(firstReady.promise).mockResolvedValue(true)
  let connected = true
  useAppStore.getState().queueTabStartupCommand('tab-1', {
    command: '/desktop/codex',
    launchToken: 'launch-1',
    launchAgent: 'codex',
    freshAgentLaunch: { prompt: 'ship it', promptDelivery: 'draft' }
  })
  const startup = useAppStore.getState().pendingStartupByTabId['tab-1']
  const transport = { getPtyId: () => ptyId }
  const session = {
    transport,
    activePanePtyBinding: null,
    bindProcessExitState: vi.fn(),
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt',
      paneTransportsRef: { current: new Map([[1, transport]]) },
      updateTabPtyId: vi.fn(),
      onStartupBound: () => useAppStore.getState().consumeTabStartupCommand('tab-1', startup),
      isVisibleRef: { current: true }
    },
    pane: { id: 1, leafId },
    cacheKey: `tab-1:${leafId}`,
    paneStartup: startup,
    launchToken: 'launch-1',
    setPanePtyFitBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    reportPanePtyVisibility: vi.fn(),
    registerSideEffectFactConsumerForPty: vi.fn(),
    syncHiddenRendererPtyDelivery: vi.fn(),
    agentCompletionCoordinator: { startProcessTracking: vi.fn() },
    sampleVisiblePaneForegroundAgent: vi.fn(),
    resolveExpectedLaunchTuiAgent: () => null
  }
  installPanePtyVisibilityBind(session as never)
  ;(session as unknown as { bindActivePanePty: (pty: string) => void }).bindActivePanePty(ptyId)
  expect(useAppStore.getState().agentLaunchConfigByPaneKey[`tab-1:${leafId}`]?.identity).toEqual(
    expect.objectContaining({ launchToken: 'launch-1', terminalHandle: 'pty-1' })
  )
  expect(useAppStore.getState().pendingStartupByTabId['tab-1']).toBeUndefined()
  const first = deliver(undefined, false, () => connected)
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce())
  connected = false
  firstReady.resolve(false)
  await expect(first).resolves.toBe(false)
  expect(mocks.write).not.toHaveBeenCalled()
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(false)
  expect(mocks.error).not.toHaveBeenCalled()
  expect(mocks.failed).not.toHaveBeenCalled()
  expect(mocks.draft).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 'tab-1', text: 'ship it\nwith tests' })
  )
  const { createRemoteRuntimePtyTransport } =
    await import('@/components/terminal-pane/remote-runtime-pty-transport')
  const {
    TerminalStreamOpcode,
    decodeTerminalStreamFrame,
    decodeTerminalStreamJson,
    encodeTerminalStreamFrame
  } = await import('../../../shared/terminal/stream/terminal-stream-protocol')
  let unpublished = true
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    api: {
      runtimeEnvironments: {
        call: async (args: { method: string }) => ({
          ...(args.method === 'terminal.resolvePane' && unpublished
            ? { ok: false, error: { code: 'terminal_not_found', message: 'terminal_not_found' } }
            : { ok: true }),
          id: 'reply',
          result:
            args.method === 'status.get'
              ? {
                  runtimeProtocolVersion: 3,
                  minCompatibleRuntimeClientVersion: 2,
                  capabilities: []
                }
              : { terminal: { handle: 'pty-1', tabId: 'tab-1', leafId, worktreeId: 'wt' } },
          _meta: { runtimeId: 'runtime' }
        }),
        subscribe: async (
          _args: unknown,
          callbacks: { onResponse: (r: unknown) => void; onBinary: (b: Uint8Array) => void }
        ) => {
          queueMicrotask(() =>
            callbacks.onResponse({
              id: 'ready',
              ok: true,
              result: { type: 'ready' },
              _meta: { runtimeId: 'runtime' }
            })
          )
          return {
            unsubscribe: vi.fn(),
            sendBinary: (bytes: Uint8Array) => {
              const frame = decodeTerminalStreamFrame(bytes)
              if (frame?.opcode === TerminalStreamOpcode.Subscribe) {
                const payload = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)!
                queueMicrotask(() =>
                  callbacks.onBinary(
                    encodeTerminalStreamFrame({
                      opcode: TerminalStreamOpcode.SnapshotEnd,
                      streamId: payload.streamId,
                      seq: 1,
                      payload: new Uint8Array()
                    })
                  )
                )
              }
            }
          }
        }
      }
    }
  })
  const exit = vi.fn()
  Object.assign(session.deps, {
    isPtyShutdownPending: () => false,
    consumeSuppressedPtyExit: () => false,
    clearRuntimePaneTitle: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    onPtyExitRef: { current: exit }
  })
  const exitSession = Object.assign(session, {
    runtimeEnvironmentId: 'env',
    resetRendererOrderedSeqForPtyExit: vi.fn(),
    dropSideEffectFactConsumer: vi.fn(),
    releaseHiddenRendererPtyDelivery: vi.fn(),
    manager: { setPaneGpuRendering: vi.fn() },
    agentCompletionCoordinator: { dispose: vi.fn() }
  }) as unknown as ConnectPanePtySession
  installPtyExitHibernate(exitSession)
  useAppStore
    .getState()
    .setAgentStatus(
      session.cacheKey,
      { state: 'working', prompt: 'ship it', agentType: 'codex' },
      'Codex',
      undefined,
      { tabId: 'tab-1', worktreeId: 'wt', terminalHandle: 'pty-1' },
      { launchToken: 'launch-1' }
    )
  const lost = createRemoteRuntimePtyTransport('env', {
    worktreeId: 'wt',
    tabId: 'tab-1',
    leafId,
    onPtyExit: exitSession.onExit
  })
  exitSession.transport = lost
  exitSession.deps.paneTransportsRef.current.set(1, lost)
  lost.attach({ existingPtyId: ptyId, callbacks: {} })
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(ptyId, -1))
  expect(useAppStore.getState().agentStatusByPaneKey[session.cacheKey]).toBeUndefined()
  expect(useAppStore.getState().agentLaunchConfigByPaneKey[session.cacheKey]?.identity).toEqual(
    expect.objectContaining({ launchToken: 'launch-1', terminalHandle: 'pty-1' })
  )
  expect(mocks.error).not.toHaveBeenCalled()
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(false)
  lost.disconnect()
  unpublished = false
  const replacement = createRemoteRuntimePtyTransport('env', {
    worktreeId: 'wt',
    tabId: 'tab-1',
    leafId
  })
  replacement.attach({ existingPtyId: ptyId, callbacks: {} })
  await vi.waitFor(() =>
    expect(mocks.write).toHaveBeenCalledWith(
      ptyId,
      '\x1b[200~ship it\rwith tests\x1b[201~',
      'launch'
    )
  )
  replacement.disconnect()
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(true)
  expect(mocks.error).not.toHaveBeenCalled()
  exitSession.handledExitPtyId = null
  exitSession.onExit(ptyId, -1)
  expect(useAppStore.getState().agentLaunchConfigByPaneKey[session.cacheKey]).toBeUndefined()
  forgetAgentStartupDeliveriesForTabs(['tab-1'])
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(false)
})

it('keeps the initial readiness attempt when its pane confirms the same PTY', async () => {
  const ready = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValue(ready.promise)
  const result = deliver()
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce())
  rebindPendingAgentStartupPrompt({ ...identity, ptyId: ptyId, beforePaste: () => true })
  ready.resolve(true)
  await expect(result).resolves.toBe(true)
  expect(mocks.error).not.toHaveBeenCalled()
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
    ptyId,
    '\x1b[200~ship it\rwith tests\x1b[201~',
    'launch'
  )
})

it('claims at the first write and never replays partially accepted input', async () => {
  mocks.ready.mockResolvedValue(true)
  mocks.write.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  await expect(deliver('x'.repeat(70_000))).resolves.toBe(false)
  expect(mocks.write.mock.calls[0]).toEqual([ptyId, '\x1b[200~', 'launch'])
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(true)
  const writes = mocks.write.mock.calls.length
  rebindPendingAgentStartupPrompt({
    ...identity,
    ptyId: 'pty-replacement',
    beforePaste: () => true
  })
  await expect(deliver('x'.repeat(70_000))).resolves.toBe(false)
  expect(mocks.write).toHaveBeenCalledTimes(writes)
  expect(mocks.error).toHaveBeenCalledOnce()
})

it('expires a never-observed adopted tab without store updates and fences late readiness', async () => {
  vi.useFakeTimers()
  const ready = Promise.withResolvers<boolean>()
  mocks.ready.mockResolvedValueOnce(false).mockReturnValue(ready.promise)
  useAppStore.setState({ tabsByWorktree: {} })
  const pending = deliver(undefined, true)
  await vi.advanceTimersByTimeAsync(0)
  await expect(pending).resolves.toBe(false)
  expect(mocks.failed).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  rebindPendingAgentStartupPrompt({ ...identity, ptyId, beforePaste: () => true })
  await vi.advanceTimersByTimeAsync(
    REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + resolveDraftPasteReadyTimeoutMs('codex') - 1000
  )
  expect(mocks.error).toHaveBeenCalledOnce()
  expect(mocks.failed).toHaveBeenCalledWith('tab-1')
  expect(mocks.prompt).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'ship it\nwith tests' })
  )
  expect(mocks.draft).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 'tab-1', agent: 'codex', text: 'ship it\nwith tests' })
  )
  ready.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.write).not.toHaveBeenCalled()
  rebindPendingAgentStartupPrompt({ ...identity, ptyId: ptyId })
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.write).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledOnce()
})

it('workspace purge retires an obligation even when its adopted tab was never observed', async () => {
  vi.useFakeTimers()
  const ready = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValue(ready.promise)
  useAppStore.setState({ tabsByWorktree: {} })
  const pending = deliver()
  await vi.advanceTimersByTimeAsync(0)
  useAppStore.getState().purgeWorktreeTerminalState(['wt'])
  ready.resolve(true)
  await pending
  await vi.advanceTimersByTimeAsync(1_000_000)
  expect(mocks.write).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
  expect(mocks.failed).not.toHaveBeenCalled()
})

it('expiry during an acknowledged chunk stops content and closes bracketed paste without replay', async () => {
  vi.useFakeTimers()
  mocks.ready.mockResolvedValue(true)
  const contentWrite = Promise.withResolvers<boolean>()
  mocks.write
    .mockResolvedValue(true)
    .mockResolvedValueOnce(true)
    .mockReturnValueOnce(contentWrite.promise)
  const pending = deliver('x'.repeat(70_000))
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.write.mock.calls[1]).toEqual([ptyId, 'x'.repeat(16_384), 'launch'])
  await vi.advanceTimersByTimeAsync(
    REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + resolveDraftPasteReadyTimeoutMs('codex')
  )
  expect(mocks.error).toHaveBeenCalledOnce()
  contentWrite.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  await expect(pending).resolves.toBe(false)
  expect(mocks.write.mock.calls.map((call) => call[1])).toEqual([
    '\x1b[200~',
    'x'.repeat(16_384),
    '\x1b[201~'
  ])
  rebindPendingAgentStartupPrompt({ ...identity, ptyId, beforePaste: () => true })
  await vi.advanceTimersByTimeAsync(1000)
  expect(mocks.write).toHaveBeenCalledTimes(3)
  expect(mocks.error).toHaveBeenCalledOnce()
})

it('settled Aider failure copies the original prompt for its existing terminal', async () => {
  vi.useFakeTimers()
  const ready = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValue(ready.promise)
  const copy = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { ui: { writeClipboardText: copy } } })
  useAppStore.setState({
    activeModal: 'agent-session-history',
    nativeChatLaunchDraftByTabId: {},
    seedNativeChatLaunchDraft: originalState.seedNativeChatLaunchDraft,
    seedNativeChatLaunchPrompt: originalState.seedNativeChatLaunchPrompt,
    markNativeChatLaunchPromptFailed: originalState.markNativeChatLaunchPromptFailed
  })
  const pending = deliverCreatedWebRuntimeAgentSessionPrompt(created, {
    agent: 'aider',
    rendererTabId: 'tab-1',
    startupDelivery: identity,
    promptAfterReady: 'fix the parser',
    submitPrompt: true,
    forcePromptPaste: true,
    launchPty: Promise.resolve(ptyId)
  })
  await vi.advanceTimersByTimeAsync(
    REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + resolveDraftPasteReadyTimeoutMs('aider')
  )
  expect(mocks.error).toHaveBeenCalledOnce()
  const recovery = mocks.error.mock.calls[0]?.[1].action
  recovery.onClick()
  expect(copy).toHaveBeenCalledExactlyOnceWith('fix the parser')
  expect(useAppStore.getState().activeModal).toBe('agent-session-history')
  expect(useAppStore.getState().nativeChatLaunchDraftByTabId['tab-1']?.text).toBe('fix the parser')
  ready.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  await expect(pending).resolves.toBe(false)
  expect(mocks.write).not.toHaveBeenCalled()
})

it('tokenless effective configuration registration is not proof that the pending launch was replaced', async () => {
  registerAgentStartupTerminalBinding({ ...identity, leafId, ptyId, agent: 'codex' })
  const ready = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValue(ready.promise)
  const pending = deliver()
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce())
  const replacement = {
    cacheKey: `tab-1:${leafId}`,
    runtimeEnvironmentId: 'env',
    paneStartup: undefined,
    pane: { id: 1, leafId },
    deps: { tabId: 'tab-1', worktreeId: 'wt' },
    transport: { getPtyId: () => ptyId }
  } as unknown as ConnectPanePtySession
  installSleepingRecordAccess(replacement)
  expect(replacement.launchToken).toBeUndefined()
  replacement.registerEffectiveLaunchConfig(
    {
      agentCommand: 'codex',
      agentArgs: '--model host-model',
      agentEnv: {}
    },
    {}
  )
  expect(
    useAppStore.getState().agentLaunchConfigByPaneKey[`tab-1:${leafId}`]?.identity
  ).toMatchObject({
    launchToken: 'launch-1',
    terminalHandle: 'pty-1'
  })
  useAppStore.getState().registerAgentLaunchConfig(
    `tab-1:${leafId}`,
    {
      agentCommand: 'codex',
      agentArgs: '--model host-model',
      agentEnv: {}
    },
    { tabId: 'tab-1', leafId, agentType: 'codex' }
  )
  ready.resolve(true)
  await expect(pending).resolves.toBe(true)
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
    ptyId,
    '\x1b[200~ship it\rwith tests\x1b[201~',
    'launch'
  )
  expect(mocks.error).not.toHaveBeenCalled()
})

it('a token-only terminal binding cannot author an empty Arguments resume override', () => {
  const paneKey = `tab-1:${leafId}`
  registerAgentStartupTerminalBinding({ ...identity, leafId, ptyId, agent: 'codex' })
  useAppStore
    .getState()
    .setAgentStatus(
      paneKey,
      { state: 'working', prompt: 'ship it', agentType: 'codex' },
      'Codex',
      undefined,
      { tabId: 'tab-1', worktreeId: 'wt', terminalHandle: 'pty-1' },
      { launchToken: 'launch-1', providerSession: { key: 'session_id', id: 'session-1' } }
    )
  const entry = useAppStore.getState().agentStatusByPaneKey[paneKey]
  expect(entry).toBeDefined()
  expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'session-1' }
  })
  expect(
    useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]?.launchConfig
  ).toBeUndefined()
  expect(useAppStore.getState().getAgentLaunchConfigForStatusEntry(entry!)).toBeUndefined()
})
